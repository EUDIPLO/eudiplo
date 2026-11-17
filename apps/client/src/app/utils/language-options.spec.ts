import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LANGUAGE,
  firstUnusedLanguage,
  LANGUAGE_OPTIONS,
  languageOf,
  languageOptionsWith,
} from './language-options';

describe('language options', () => {
  it('offers language-only tags and starts with English', () => {
    expect(DEFAULT_LANGUAGE).toBe('en');
    expect(LANGUAGE_OPTIONS.map(({ value }) => value)).toEqual(
      expect.arrayContaining(['de', 'ro', 'el', 'sv'])
    );
    expect(LANGUAGE_OPTIONS).toHaveLength(24);
    expect(LANGUAGE_OPTIONS.every(({ value }) => /^[a-z]{2}$/.test(value))).toBe(true);
  });

  it('keeps a stored tag the list lacks, so editing shows and keeps it', () => {
    expect(languageOptionsWith('de-DE').at(-1)).toEqual({
      value: 'de-DE',
      label: 'German (de-DE)',
    });
    // A select matches exactly, so another casing gets an option of its own.
    expect(languageOptionsWith('EN').at(-1)).toEqual({ value: 'EN', label: 'English (EN)' });
    expect(languageOptionsWith('zz-ZZ').at(-1)?.label).toBe('zz-ZZ');
    expect(languageOptionsWith('1-x').at(-1)?.label).toBe('1-x');
    expect(languageOptionsWith('de')).toBe(LANGUAGE_OPTIONS);
    expect(languageOptionsWith('')).toBe(LANGUAGE_OPTIONS);
    expect(languageOptionsWith(undefined)).toBe(LANGUAGE_OPTIONS);
  });

  it('compares languages, not regions', () => {
    expect(languageOf('de-DE')).toBe('de');
    expect(languageOf('DE')).toBe('de');
    expect(languageOf(undefined)).toBe('');
    expect(firstUnusedLanguage(['en-US'])).toBe('de');
    expect(firstUnusedLanguage(['EN', 'de-AT'])).toBe('bg');
    expect(firstUnusedLanguage(LANGUAGE_OPTIONS.map(({ value }) => value))).toBeUndefined();
  });
});
