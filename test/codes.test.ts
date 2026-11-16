import { describe, expect, it } from 'vitest';

import { describeCode } from '../src/sia/codes.js';
import { AJAX_CODES } from './ajaxCodes.js';


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
