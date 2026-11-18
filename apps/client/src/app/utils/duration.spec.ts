import { describe, expect, it } from 'vitest';

import { formatDuration } from './duration';

describe('formatDuration', () => {
  it('names a duration in its largest whole unit', () => {
    expect(formatDuration(86_400)).toBe('1 day');
    expect(formatDuration(3 * 86_400)).toBe('3 days');
    expect(formatDuration(36 * 3_600)).toBe('36 hours');
    expect(formatDuration(90 * 60)).toBe('90 minutes');
  });

  it('falls back to seconds for durations without a whole minute', () => {
    expect(formatDuration(90)).toBe('90 seconds');
    expect(formatDuration(1)).toBe('1 second');
  });
});
