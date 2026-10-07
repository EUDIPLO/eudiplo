import { describe, expect, it } from 'vitest';
import { hostedVctUrl, trustListUrl } from './public-url';

describe('public URLs', () => {
  it('builds the trust list URL like the backend, with an encoded list ID', () => {
    expect(trustListUrl('https://eudiplo.example.com', 'acme', 'members 2026')).toBe(
      'https://eudiplo.example.com/issuers/acme/trust-list/members%202026'
    );
  });

  it('builds the URL of hosted VCT metadata', () => {
    expect(hostedVctUrl('https://eudiplo.example.com', 'acme', 'membership')).toBe(
      'https://eudiplo.example.com/issuers/acme/credentials-metadata/vct/membership'
    );
  });
});
