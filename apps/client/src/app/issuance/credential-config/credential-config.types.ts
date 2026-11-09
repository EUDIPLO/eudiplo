// Interfaces for credential configuration forms

export interface DisplayFormValue {
  name: string;
  description?: string;
  locale: string;
  background_color?: string;
  text_color?: string;
  logo?: {
    uri?: string;
    url?: string;
  };
  background_image?: {
    uri?: string;
    url?: string;
  };
}

/** Key attestation levels (HAIP) the form offers, with the names both pages show. */
export const KEY_ATTESTATION_LEVELS = [
  { label: 'ISO 18045 High', value: 'iso_18045_high' },
  { label: 'ISO 18045 Moderate', value: 'iso_18045_moderate' },
];
