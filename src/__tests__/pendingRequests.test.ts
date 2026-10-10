import { describe, it, expect } from 'vitest';
import { splitCustomId } from '../services/pendingRequests.js';

describe('splitCustomId', () => {
  it('parses IDs that contain underscores (real OpenCode `que_`/`per_` ids)', () => {
    expect(splitCustomId('qsel_que_000a699a1001zuSASRmwJvLBam_2', 'qsel_')).toEqual({
      requestID: 'que_000a699a1001zuSASRmwJvLBam',
      suffix: '2',
    });
    expect(splitCustomId('preply_per_000b018d2001C79NSV2KcjpR4b_once', 'preply_')).toEqual({
      requestID: 'per_000b018d2001C79NSV2KcjpR4b',
      suffix: 'once',
    });
    expect(splitCustomId('qother-modal_que_000b3422d001Xl1w4uEOGiZcCR_0', 'qother-modal_')).toEqual({
      requestID: 'que_000b3422d001Xl1w4uEOGiZcCR',
      suffix: '0',
    });
  });

  it('keeps only the last segment as suffix', () => {
    expect(splitCustomId('preply_per_000b018d2001C79NSV2KcjpR4b_always', 'preply_')).toEqual({
      requestID: 'per_000b018d2001C79NSV2KcjpR4b',
      suffix: 'always',
    });
  });
});
