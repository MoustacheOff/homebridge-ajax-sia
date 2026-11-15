import { describe, expect, it } from 'vitest';

import { describeCode } from '../src/sia/codes.js';

describe('describeCode', () => {
  it('names the codes Ajax documents', () => {
    expect(describeCode('YC')).toBe('Hub is offline');
    expect(describeCode('XQ')).toBe('Radio interference is high');
    expect(describeCode('TA')).toBe('Tamper or lid open');
  });

  it('returns nothing for a code it does not know', () => {
    expect(describeCode('ZQ')).toBeUndefined();
    expect(describeCode('')).toBeUndefined();
  });
});
