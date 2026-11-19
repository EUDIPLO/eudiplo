import { describe, expect, it } from 'vitest';

import { formatDuration, formatLifetime } from './duration';

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

describe('formatLifetime', () => {
  it('says "Not set" without a lifetime', () => {
    expect(formatLifetime(null)).toBe('Not set');
    expect(formatLifetime(undefined)).toBe('Not set');
    expect(formatLifetime(0)).toBe('Not set');
  });

  it('names a lifetime exactly, in its largest whole unit', () => {
    expect(formatLifetime(86_400)).toBe('1 day');
    expect(formatLifetime(2 * 86_400)).toBe('2 days');
    expect(formatLifetime(90_000)).toBe('25 hours');
    expect(formatLifetime(5_400)).toBe('90 minutes');
    expect(formatLifetime(30)).toBe('30 seconds');
  });
});
