import { createHash } from 'node:crypto';

import { GrpcChannel, GrpcError, GrpcStatus, type Metadata } from './grpc.js';
import { Message, Writer } from './protobuf.js';
import { totp } from './totp.js';

/** What the hub reports for a space, from `DisplayedSpaceSecurityState`. */
export type SpaceState =
  | 'none' | 'armed' | 'disarmed' | 'night' | 'partial'
  | 'exit-delay' | 'second-stage' | 'two-stage-incomplete' | 'vds' | 'unknown';

const SPACE_STATES: SpaceState[] = [
  'none', 'armed', 'disarmed', 'night', 'partial', 'exit-delay', 'second-stage', 'two-stage-incomplete', 'vds',
];

export interface Space {
  id: string;
  hubId: string;
  name: string;
  state: SpaceState;
  online: boolean;
}

export type FailureReason =
  | 'invalid-credentials' | 'two-factor-required' | 'account-locked' | 'account-not-confirmed'
  | 'client-rejected' | 'unauthenticated' | 'unavailable' | 'rejected';

export class CloudError extends Error {
  constructor(readonly reason: FailureReason, message: string) {
    super(message);
    this.name = 'CloudError';
  }
}

export interface Session {
  token: string;
  userId: string;
}

export interface CloudOptions {
  host: string;
  port: number;
  email: string;
  /** SHA-256 hex digest of the account password, which is what the API expects. */
  passwordHash: string;
  /** Base32 secret of the authenticator app, for accounts with two-factor authentication. */
  totpSecret?: string;
  deviceId: string;
  /** The app version announced to the server. The server refuses versions it has retired. */
  clientVersion: string;
  timeoutMs?: number;
  /** Replaces the channel; for tests. */
  channel?: GrpcChannel;
}

export const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

const LOGIN = '/systems.ajax.api.ecosystem.v3.mobilegwsvc.service.login_by_password.LoginByPasswordService/execute';
const LOGIN_TOTP = '/systems.ajax.api.ecosystem.v3.mobilegwsvc.service.login_by_totp.LoginByTotpService/execute';
const FIND_SPACES = '/systems.ajax.api.ecosystem.v3.mobilegwsvc.service.find_user_spaces_with_pagination'
  + '.FindUserSpacesWithPaginationService/execute';
const SECURITY = '/systems.ajax.api.mobile.v2.space.security.SpaceSecurityService';

const USER_ROLE_USER = 1;

type Command = 'arm' | 'disarm' | 'armToNightMode' | 'disarmFromNightMode';

/** Field number -> name of the error in the `oneof` of each command's failure message. */
const ARM_ERRORS: Record<number, string> = {
  1: 'bad_request', 2: 'space_not_found', 3: 'permission_denied', 4: 'another_transition_is_in_progress',
  5: 'already_in_the_requested_security_state', 6: 'illegal_space_security_mode', 7: 'hub_offline', 8: 'hub_busy',
  9: 'hub_blocked_by_service_provider', 10: 'hub_alarm_reset_required', 11: 'hub_detected_malfunctions',
  12: 'space_locked', 13: 'action_is_limited_in_empty_space', 14: 'hub_not_allowed_to_perform_command',
};
const DISARM_ERRORS: Record<number, string> = {
  1: 'bad_request', 2: 'space_not_found', 3: 'permission_denied', 4: 'another_transition_is_in_progress',
  5: 'already_in_the_requested_security_state', 6: 'illegal_space_security_mode', 7: 'hub_offline', 8: 'hub_busy',
  9: 'space_locked', 10: 'hub_not_allowed_to_perform_command',
};
const COMMAND_ERRORS: Record<Command, Record<number, string>> = {
  arm: ARM_ERRORS,
  armToNightMode: ARM_ERRORS,
  disarm: DISARM_ERRORS,
  disarmFromNightMode: DISARM_ERRORS,
};

/** Failures of the commands above that mean the goal is already reached. */
const BENIGN = new Set(['already_in_the_requested_security_state']);

/**
 * Client for the few Ajax cloud calls needed to read the state of a space and to arm or disarm it.
 *
 * This speaks the protocol of the Ajax mobile apps; it is not an official, supported API.
 */
export class AjaxCloud {
  private readonly channel: GrpcChannel;
  private session?: Session;

  constructor(private readonly options: CloudOptions) {
    this.channel = options.channel ?? new GrpcChannel(`https://${options.host}:${options.port}`);
  }

  restore(session: Session | undefined): void {
    this.session = session;
  }

  get current(): Session | undefined {
    return this.session;
  }

  async login(): Promise<Session> {
    const request = new Writer()
      .string(1, this.options.email)
      .string(2, this.options.passwordHash)
      .varint(3, USER_ROLE_USER);
    const response = Message.decode(await this.call(LOGIN, request.finish(), this.deviceMetadata()));

    const failure = response.message(2);
    if (failure) {
      const [error] = failure.numbers;
      switch (error) {
        case 2:
          return this.loginWithTotp(failure.message(2)?.string(1) ?? '');
        case 3: throw new CloudError('account-not-confirmed', 'The Ajax account is not confirmed');
        case 4: throw new CloudError('account-locked', 'The Ajax account is locked');
        case 5: throw new CloudError('invalid-credentials', 'Invalid Ajax e-mail or password');
        default: throw new CloudError('rejected', `Login refused (error ${error ?? 'unknown'})`);
      }
    }
    return this.acceptSession(response);
  }

  private async loginWithTotp(requestId: string): Promise<Session> {
    if (!this.options.totpSecret) {
      throw new CloudError('two-factor-required', 'This Ajax account uses two-factor authentication: set "totpSecret"');
    }
    const request = new Writer()
      .string(1, this.options.email)
      .varint(2, USER_ROLE_USER)
      .string(3, totp(this.options.totpSecret))
      .string(4, requestId);
    const response = Message.decode(await this.call(LOGIN_TOTP, request.finish(), this.deviceMetadata()));

    const failure = response.message(2);
    if (failure) {
      const [error] = failure.numbers;
      switch (error) {
        case 2: throw new CloudError('account-not-confirmed', 'The Ajax account is not confirmed');
        case 3: throw new CloudError('account-locked', 'The Ajax account is locked');
        case 4: throw new CloudError('invalid-credentials', 'Ajax rejected the two-factor code: check "totpSecret" and the clock');
        default: throw new CloudError('rejected', `Two-factor login refused (error ${error ?? 'unknown'})`);
      }
    }
    return this.acceptSession(response);
  }

  private acceptSession(response: Message): Session {
    const success = response.message(1);
    const token = success?.bytes(1);
    const userId = success?.message(2)?.string(1);
    if (!token?.length || !userId) {
      throw new CloudError('rejected', 'Login succeeded without a session');
    }
    this.session = { token: token.toString('hex'), userId };
    return this.session;
  }

  async spaces(): Promise<Space[]> {
    const request = new Writer().varint(1, 100);
    const response = Message.decode(await this.authenticated(FIND_SPACES, request.finish()));
    const success = response.message(1);
    if (!success) {
      throw new CloudError('rejected', 'Ajax refused to list the spaces');
    }
    return success.messages(1).map((space) => ({
      id: space.string(1),
      hubId: space.string(999),
      name: space.message(2)?.string(1) ?? '',
      state: SPACE_STATES[space.varint(3)] ?? 'unknown',
      online: space.varint(998) === 1,
    }));
  }

  /** Sends one arming command. A request to reach the state the space is already in counts as success. */
  async command(spaceId: string, command: Command): Promise<void> {
    const locator = new Writer().string(1, spaceId, true);
    const request = new Writer().message(1, locator);
    const response = Message.decode(await this.authenticated(`${SECURITY}/${command}`, request.finish()));

    const failure = response.message(2);
    if (!failure) {
      return;
    }
    const [error] = failure.numbers;
    const name = (error !== undefined && COMMAND_ERRORS[command][error]) || `error_${error ?? 'unknown'}`;
    if (BENIGN.has(name)) {
      return;
    }
    throw new CloudError('rejected', `Ajax refused "${command}": ${name.replace(/_/g, ' ')}`);
  }

  private async authenticated(path: string, message: Buffer): Promise<Buffer> {
    if (!this.session) {
      await this.login();
    }
    try {
      return await this.call(path, message, this.sessionMetadata());
    } catch (error) {
      if (!(error instanceof CloudError) || error.reason !== 'unauthenticated') {
        throw error;
      }
    }
    // The session expired: log in again, once.
    await this.login();
    return this.call(path, message, this.sessionMetadata());
  }

  private async call(path: string, message: Buffer, metadata: Metadata): Promise<Buffer> {
    try {
      return await this.channel.unary(path, message, metadata, this.options.timeoutMs ?? 15_000);
    } catch (error) {
      if (!(error instanceof GrpcError)) {
        throw error;
      }
      throw translate(error);
    }
  }

  private deviceMetadata(): Metadata {
    return {
      'client-device-id': this.options.deviceId,
      'client-device-model': 'SM-A536B',
      'client-os': 'Android',
      'client-version-major': this.options.clientVersion,
      'application-label': 'Ajax',
      'client-device-type': 'MOBILE',
    };
  }

  private sessionMetadata(): Metadata {
    const { token, userId } = this.session!;
    return {
      'client-session-token': token,
      'a911-user-id': userId,
      'client-user-login': this.options.email,
      'client-user-role': 'USER',
      ...this.deviceMetadata(),
    };
  }
}

function translate(error: GrpcError): CloudError {
  if (error.code === GrpcStatus.PERMISSION_DENIED && /blacklist/i.test(error.message)) {
    return new CloudError('client-rejected', 'Ajax no longer accepts this client version: raise "clientVersion"');
  }
  if (error.code === GrpcStatus.UNAUTHENTICATED) {
    return new CloudError('unauthenticated', 'Ajax session expired');
  }
  if (error.code === GrpcStatus.UNAVAILABLE || error.code === GrpcStatus.DEADLINE_EXCEEDED) {
    return new CloudError('unavailable', `Ajax cloud unreachable: ${error.message}`);
  }
  return new CloudError('rejected', `Ajax cloud error ${error.code}: ${error.message}`);
}
