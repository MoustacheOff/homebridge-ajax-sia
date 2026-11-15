import { describe, expect, it } from 'vitest';

import { describeCode } from '../src/sia/codes.js';

/** Every SIA code in Ajax's "SIA codes for OS Malevich" table, hub firmware 2.43. */
const AJAX_CODES = [
  'AB', 'AC', 'AD', 'AE', 'AF', 'AG', 'AH', 'AI', 'AR', 'AT', 'AY', 'BA', 'BB', 'BG',
  'BJ', 'BR', 'BS', 'BT', 'BU', 'BV', 'BX', 'CA', 'CB', 'CC', 'CD', 'CF', 'CG', 'CI',
  'CL', 'CR', 'CS', 'EA', 'EJ', 'EM', 'EN', 'ES', 'FA', 'FC', 'FH', 'FJ', 'FS', 'FT',
  'FX', 'GA', 'GH', 'GS', 'GX', 'HA', 'HB', 'HU', 'HV', 'JA', 'KA', 'KG', 'KH', 'KJ',
  'KR', 'KT', 'LR', 'LT', 'MA', 'MR', 'NB', 'NC', 'ND', 'NE', 'NF', 'NL', 'NO', 'NP',
  'OA', 'OB', 'OC', 'OG', 'OP', 'OR', 'OS', 'OU', 'OV', 'PA', 'PC', 'PD', 'PE', 'PF',
  'PG', 'PH', 'PO', 'QB', 'QU', 'RB', 'RG', 'RL', 'RP', 'RS', 'SC', 'SM', 'TA', 'TB',
  'TR', 'TU', 'UA', 'UH', 'UJ', 'UR', 'US', 'UT', 'WA', 'WH', 'XC', 'XH', 'XI', 'XL',
  'XQ', 'XR', 'XT', 'YA', 'YC', 'YF', 'YG', 'YK', 'YM', 'YP', 'YQ', 'YR', 'YS', 'YT',
  'YW', 'YX', 'YY', 'YZ', 'ZA', 'ZR', 'ZY', 'ZZ',
];

describe('describeCode', () => {
  it.each(AJAX_CODES)('names %s', (code) => {
    expect(describeCode(code)).toBeTruthy();
  });

  it('names the codes Ajax documents', () => {
    expect(describeCode('YC')).toBe('Hub is offline');
    expect(describeCode('OS')).toBe('Armed with an arm switch');
    expect(describeCode('CS')).toBe('Disarmed with an arm switch');
  });

  it('returns nothing for a code Ajax does not list', () => {
    expect(describeCode('ZQ')).toBeUndefined();
    expect(describeCode('')).toBeUndefined();
  });
});
