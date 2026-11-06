import { describe, expect, it } from 'vitest';
import { FormArray, FormControl, FormGroup } from '@angular/forms';
import {
  displayColorValidator,
  uniqueDisplayLocaleValidator,
  walletDisplayEntries,
} from './display-entries';

describe('displayColorValidator', () => {
  const errors = (value: string | null) => displayColorValidator(new FormControl(value));

  it('accepts empty values and the CSS Color Level 3 numerical values the API accepts', () => {
    for (const value of [
      null,
      '',
      ' ',
      '#fff',
      '#12107C',
      ' #12107c ',
      'rgb(18, 16, 124)',
      'rgb(7%, 6%, 49%)',
      'rgba(18, 16, 124, 0.5)',
      'hsl(242, 77%, 27%)',
      'hsla(242, 77%, 27%, 1)',
      'transparent',
    ]) {
      expect(errors(value), String(value)).toBeNull();
    }
  });

  it('refuses keywords, typos and newer color forms', () => {
    for (const value of [
      'navy',
      'blu',
      '#FFFFF',
      '#12107c80',
      'oklch(40% 0.2 270)',
      'rgb(foo)',
      'rgb(18 16 124)',
      'hsl(242, 77, 27)',
    ]) {
      expect(errors(value), value).toEqual({ displayColor: true });
    }
  });
});

describe('uniqueDisplayLocaleValidator', () => {
  const entries = (...locales: string[]) =>
    new FormArray(
      locales.map(
        (locale) => new FormGroup({ locale: new FormControl(locale, uniqueDisplayLocaleValidator) })
      )
    );
  const errorsOf = (array: FormArray) =>
    array.controls.map((entry) => {
      entry.get('locale')!.updateValueAndValidity();
      return entry.get('locale')!.errors;
    });

  it('marks later entries that repeat a locale, compared case-insensitively', () => {
    expect(errorsOf(entries('en-US', 'de-DE', 'en-us', 'de-DE'))).toEqual([
      null,
      null,
      { duplicateLocale: { firstIndex: 0 } },
      { duplicateLocale: { firstIndex: 1 } },
    ]);
  });

  it('accepts distinct locales and a control outside a FormArray', () => {
    expect(errorsOf(entries('en-US', 'en-GB'))).toEqual([null, null]);
    expect(uniqueDisplayLocaleValidator(new FormControl('en-US'))).toBeNull();
  });
});

describe('walletDisplayEntries', () => {
  it('keeps the first entry per locale and only colors wallets can read', () => {
    expect(
      walletDisplayEntries([
        { name: 'A', locale: 'en-US', background_color: ' #fff ', text_color: 'navy' },
        { name: 'B', locale: 'en-us' },
        { name: 'C', locale: 'de-DE', text_color: 'RGB(1, 2, 3)' },
      ])
    ).toEqual([
      { name: 'A', locale: 'en-US', background_color: '#fff' },
      { name: 'C', locale: 'de-DE', text_color: 'rgb(1, 2, 3)' },
    ]);
  });
});
