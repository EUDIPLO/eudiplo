import { FormControl, ValidatorFn, Validators } from '@angular/forms';
import trustListCreateSchema from '../../../../../../schemas/TrustListCreateDto.schema.json';

// The API's patterns (TRUST_LIST_EMAIL_PATTERN, TRUST_LIST_WEBSITE_PATTERN and
// TRUST_LIST_PHONE_PATTERN in @eudiplo/config-format), read from the committed
// schema so the form accepts what the API accepts for TEElectronicAddress
// (ETSI TS 119 602 clause 6.5.3.2).
const info = trustListCreateSchema.properties.entities.items.oneOf[0].properties.info.properties;

const TRUST_LIST_EMAIL = new RegExp(info.contactUri.pattern);
const TRUST_LIST_WEBSITE = new RegExp(info.website.pattern);
const TRUST_LIST_PHONE = new RegExp(info.phone.pattern);

export const emailValidators: ValidatorFn[] = [
  Validators.required,
  Validators.pattern(TRUST_LIST_EMAIL),
];
/**
 * The backend's isTrustListWebsite rule beyond the pattern: the URI is written as a URL parser
 * serializes it (lower-case host, percent-encoded characters), only a missing "/" path after the
 * host is tolerated.
 */
const serializedUrl: ValidatorFn = (control) => {
  const value: unknown = control.value;
  if (typeof value !== 'string' || !value || !TRUST_LIST_WEBSITE.test(value)) return null;
  try {
    const { href } = new URL(value);
    return href === value || href === `${value}/` ? null : { serializedUrl: href };
  } catch {
    return { serializedUrl: true };
  }
};

export const websiteValidators: ValidatorFn[] = [
  Validators.required,
  Validators.pattern(TRUST_LIST_WEBSITE),
  serializedUrl,
];
export const phoneValidators: ValidatorFn[] = [Validators.pattern(TRUST_LIST_PHONE)];

/** Messages under the fields when a local validator fails. */
export const ELECTRONIC_ADDRESS_MESSAGES = {
  email: {
    required: 'Enter an e-mail address; ETSI TS 119 602 requires one.',
    pattern: 'Enter one e-mail address in ASCII characters, for example info@example.com.',
  },
  website: {
    required: 'Enter a website; ETSI TS 119 602 requires one.',
    pattern: 'Enter an http or https URI, for example https://example.com/.',
    serializedUrl:
      'Write the URI as a browser shows it: lower-case host, special characters percent-encoded.',
  },
  phone: {
    pattern: 'Enter the number in international form without spaces, for example +49-30-1234567.',
  },
} as const;

/** One TEElectronicAddress entry of a published list. */
interface ElectronicAddress {
  uriValue?: string;
}

/**
 * Sorts the published TEElectronicAddress entries of a list without stored
 * entity config into the form's fields by URI scheme: mailto:, http(s) and tel:.
 */
export function readElectronicAddress(addresses: ElectronicAddress[] | undefined): {
  contactUri: string;
  website: string;
  phone: string;
} {
  const values = (addresses ?? []).map((entry) => entry.uriValue ?? '');
  return {
    contactUri: values.find((value) => value.startsWith('mailto:')) ?? '',
    website: values.find((value) => /^https?:/.test(value)) ?? '',
    phone: values.find((value) => value.startsWith('tel:')) ?? '',
  };
}

/** The form controls of an entity's electronic address, with the API's validators. */
export function electronicAddressControls(
  address: { contactUri?: string; website?: string; phone?: string } = {}
): {
  infoContactUri: FormControl<string>;
  infoWebsite: FormControl<string>;
  infoPhone: FormControl<string>;
} {
  return {
    infoContactUri: new FormControl(address.contactUri || '', {
      nonNullable: true,
      validators: emailValidators,
    }),
    infoWebsite: new FormControl(address.website || '', {
      nonNullable: true,
      validators: websiteValidators,
    }),
    infoPhone: new FormControl(address.phone || '', {
      nonNullable: true,
      validators: phoneValidators,
    }),
  };
}
