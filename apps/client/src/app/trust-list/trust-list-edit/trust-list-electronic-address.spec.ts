import { FormControl } from '@angular/forms';
import { describe, expect, it } from 'vitest';
import {
  emailValidators,
  phoneValidators,
  readElectronicAddress,
  websiteValidators,
} from './trust-list-electronic-address';

describe('trust list electronic address', () => {
  const errors = (validators: typeof emailValidators, value: string) =>
    new FormControl(value, { validators }).errors;

  it('requires an e-mail address the API accepts', () => {
    expect(errors(emailValidators, 'info@example.com')).toBeNull();
    expect(errors(emailValidators, 'mailto:info@example.com')).toBeNull();
    expect(errors(emailValidators, '')).toEqual({ required: true });
    for (const value of ['info', 'https://example.com/contact', 'info@localhost']) {
      expect(errors(emailValidators, value)).toHaveProperty('pattern');
    }
  });

  it('requires an http or https web site', () => {
    expect(errors(websiteValidators, 'https://example.com/')).toBeNull();
    expect(errors(websiteValidators, '')).toEqual({ required: true });
    for (const value of ['example.com', 'ftp://example.com/', 'https://exa mple.com/']) {
      expect(errors(websiteValidators, value)).toHaveProperty('pattern');
    }
    // The backend's serialized-form rule.
    for (const value of ['https://EXAMPLE.com/', 'https://example.com/über']) {
      expect(errors(websiteValidators, value)).toHaveProperty('serializedUrl');
    }
    expect(errors(websiteValidators, 'https://example.com')).toBeNull();
  });

  it('accepts an empty or international telephone number', () => {
    expect(errors(phoneValidators, '')).toBeNull();
    expect(errors(phoneValidators, '+49-30-1234567')).toBeNull();
    expect(errors(phoneValidators, 'tel:+49301234567')).toBeNull();
    expect(errors(phoneValidators, '030 1234567')).toHaveProperty('pattern');
  });

  it('sorts published addresses into the fields by scheme', () => {
    expect(
      readElectronicAddress([
        { uriValue: 'tel:+49301234567' },
        { uriValue: 'https://example.com/' },
        { uriValue: 'mailto:info@example.com' },
      ])
    ).toEqual({
      contactUri: 'mailto:info@example.com',
      website: 'https://example.com/',
      phone: 'tel:+49301234567',
    });
    expect(readElectronicAddress(undefined)).toEqual({ contactUri: '', website: '', phone: '' });
  });
});
