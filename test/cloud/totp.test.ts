import { describe, expect, it } from 'vitest';

import { totp } from '../../src/cloud/totp.js';

// RFC 6238 appendix B: the SHA-1 secret is the ASCII string "12345678901234567890".
const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('totp', () => {
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ])('matches the RFC test vector at t=%i', (seconds, expected) => {
    expect(totp(SECRET, seconds * 1000)).toBe(expected);
  });

  it('ignores spaces, dashes and case in the secret', () => {
    expect(totp('gezd gnbv-gy3t qojq gezd gnbv gy3t qojq', 59_000)).toBe('287082');
  });

  it('rejects a secret that is not base32', () => {
    expect(() => totp('not base32 !', 0)).toThrow(/base32/);
  });
});
