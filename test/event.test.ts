import { describe, expect, it } from 'vitest';

import { parseDataBlock } from '../src/sia/event.js';

describe('parseDataBlock', () => {
  it('reads an arming event', () => {
    expect(parseDataBlock('|Nri1/CL501]').events).toEqual([{ code: 'CL', zone: 501, area: 1 }]);
  });

  it('reads the account, user and zone', () => {
    const block = parseDataBlock('#ea1984|Nid7/ri2/BA012]');
    expect(block.account).toBe('EA1984');
    expect(block.events).toEqual([{ code: 'BA', zone: 12, area: 2, user: 7 }]);
  });

  it('keeps the timestamp', () => {
    const block = parseDataBlock('|Nri1/OP001]_14:12:04,09-25-2019');
    expect(block.timestamp).toEqual(new Date(Date.UTC(2019, 8, 25, 14, 12, 4)));
  });

  it('ignores extended data', () => {
    expect(parseDataBlock('|Nri1/BA3][A38475345]_14:12:04,09-25-2019').events).toHaveLength(1);
  });

  it('reads several events from one block', () => {
    expect(parseDataBlock('|Nri1/BA3/TA3]').events.map((event) => event.code)).toEqual(['BA', 'TA']);
  });

  it('reads the text field', () => {
    expect(parseDataBlock('#006969|Nri04/OP001*\'NM]').events[0]).toMatchObject({ code: 'OP', text: '\'NM' });
  });

  it('treats an empty block as a link test', () => {
    expect(parseDataBlock(']_14:12:04,09-25-2019').events).toEqual([]);
  });

  it('handles an event without zone', () => {
    expect(parseDataBlock('|Nri1/AT]').events).toEqual([{ code: 'AT', area: 1 }]);
  });

  it('rejects what it cannot parse', () => {
    expect(() => parseDataBlock('|Zzz]')).toThrow();
    expect(() => parseDataBlock('|Nri1/??]')).toThrow();
    expect(() => parseDataBlock('|Nri1/CL501')).toThrow(/Unterminated/);
  });
});
