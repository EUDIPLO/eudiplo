import { describe, expect, it } from 'vitest';
import {
  buildSimpleDcql,
  readSimpleDcql,
  simpleDcqlError,
  dcqlReferenceError,
  trustError,
  onlyEmptyClaimsUnsupported,
} from './simple-dcql';

const credential = {
  id: 'pid',
  format: 'dc+sd-jwt',
  meta: { vct_values: ['urn:eudi:pid:de:1'] },
  claims: [
    { path: ['given_name'] },
    { path: ['address', 'locality'] },
    { path: ['age_equal_or_over', '18'] },
  ],
};

describe('visual DCQL round trips', () => {
  const queries = {
    'nested paths, indexes and literal dots': {
      credentials: [
        {
          ...credential,
          claims: [
            ...credential.claims,
            { path: ['nationalities', 0] },
            { path: ['literal.name'] },
          ],
        },
      ],
    },
    'claim IDs and exact string constraints': {
      credentials: [
        {
          ...credential,
          claims: [{ id: 'name', path: ['given_name'], values: ['', ' Erika ', 'Erika'] }],
        },
      ],
    },
    'omitted claims (credential only)': {
      credentials: [{ id: 'pid', format: credential.format, meta: credential.meta }],
    },
    'omitted mDOC claims': {
      credentials: [
        { id: 'mdl', format: 'mso_mdoc', meta: { doctype_value: 'org.iso.18013.5.1.mDL' } },
      ],
    },
    'mDOC namespaces and retention false': {
      credentials: [
        {
          id: 'mdl',
          format: 'mso_mdoc',
          meta: { doctype_value: 'org.iso.18013.5.1.mDL' },
          claims: [
            { path: ['org.iso.18013.5.1', 'family_name'], intent_to_retain: false },
            { path: ['another.namespace', 'local.name'], intent_to_retain: true },
          ],
        },
      ],
    },
    'multiple trust sources with verification material': {
      credentials: [
        {
          ...credential,
          trusted_authorities: [
            {
              type: 'etsi_tl',
              values: [
                {
                  trustListId: 'managed',
                  url: 'https://trust.example/managed',
                  verifierX509Der: 'resolved',
                },
                {
                  url: 'https://trust.example/external',
                  verifierX509Der: 'cert',
                  verifierKey: { kty: 'EC', x: 'x' },
                },
              ],
            },
            {
              type: 'openid_federation',
              values: ['https://federation.example', 'https://another.example'],
            },
          ],
        },
      ],
    },
    'alternative bundles and optional sets': {
      credentials: [credential, { ...credential, id: 'membership' }, { ...credential, id: 'mdl' }],
      credential_sets: [
        {
          options: [
            ['pid', 'membership'],
            ['mdl', 'membership'],
          ],
        },
        { options: [['pid']], required: false },
        { options: [['membership']], required: true },
      ],
    },
  };
  for (const [label, query] of Object.entries(queries)) {
    it(`preserves ${label} through unrelated edits`, () => {
      const original = JSON.stringify(query);
      const draft = readSimpleDcql(JSON.stringify(query))!;
      expect(buildSimpleDcql(draft)).toEqual(query);
      draft.credentials[0].type = 'urn:changed';
      expect((buildSimpleDcql(draft) as any).credentials[0].claims).toEqual(
        (query.credentials[0] as { claims?: unknown }).claims
      );
      expect(JSON.stringify(query)).toBe(original);
    });
  }
  for (const [label, query] of Object.entries({
    'multiple matches': { credentials: [{ ...credential, multiple: true }] },
    'claim alternatives': { credentials: [{ ...credential, claim_sets: [['name']] }] },
    'multiple types': { credentials: [{ ...credential, meta: { vct_values: ['one', 'two'] } }] },
    'claims that are not an array': { credentials: [{ ...credential, claims: {} }] },
    'unsupported authority': {
      credentials: [{ ...credential, trusted_authorities: [{ type: 'aki', values: ['id'] }] }],
    },
    'boolean value constraints not supported by the backend schema': {
      credentials: [{ ...credential, claims: [{ path: ['age_over_18'], values: [true] }] }],
    },
    'unknown nested claim property': {
      credentials: [{ ...credential, claims: [{ path: ['name'], future: true }] }],
    },
  })) {
    it(`keeps ${label} in JSON without modifying it`, () => {
      const original = JSON.stringify(query);
      expect(readSimpleDcql(query)).toBeNull();
      expect(JSON.stringify(query)).toBe(original);
    });
  }
  it('rejects malformed input without throwing', () => {
    for (const value of ['{', 'null', '[]', '{}', { credentials: [null] }])
      expect(readSimpleDcql(value)).toBeNull();
  });
  it('omits claims instead of sending an empty array', () => {
    const draft = readSimpleDcql({ credentials: [credential] })!;
    draft.credentials[0].claims = [];
    expect(simpleDcqlError(draft)).toBeNull();
    expect((buildSimpleDcql(draft) as any).credentials[0]).not.toHaveProperty('claims');
  });
  it('keeps an empty claims list in JSON and flags it', () => {
    const query = { credentials: [{ ...credential, claims: [] }] };
    expect(readSimpleDcql(query)).toBeNull();
    expect(dcqlReferenceError(query)).toContain('Remove "claims" to request no claims');
    expect(dcqlReferenceError({ credentials: [credential] })).toBeNull();
    expect(onlyEmptyClaimsUnsupported(query)).toBe(true);
    expect(
      onlyEmptyClaimsUnsupported({ credentials: [{ ...credential, claims: [], multiple: true }] })
    ).toBe(false);
    expect(onlyEmptyClaimsUnsupported({ credentials: [credential] })).toBe(false);
  });
  it('flags duplicate IDs, empty alternatives and dangling references', () => {
    const draft = readSimpleDcql({ credentials: [credential] })!;
    expect(simpleDcqlError(draft)).toBeNull();
    expect(
      simpleDcqlError({ credentials: [...draft.credentials, ...draft.credentials] })
    ).toContain('unique query ID');
    expect(simpleDcqlError({ ...draft, credentialSets: [{ options: [[]] }] })).toContain(
      'every alternative'
    );
    expect(
      dcqlReferenceError({
        credentials: [credential],
        credential_sets: [{ options: [['missing']] }],
      })
    ).toContain('missing credential');
  });
});

describe('federation authority errors', () => {
  it('asks for a trust anchor while none is chosen, then for a valid URL', () => {
    expect(trustError([{ type: 'openid_federation', values: [''] }])).toBe(
      'Choose a federation trust anchor.'
    );
    expect(trustError([{ type: 'openid_federation', values: ['not a url'] }])).toBe(
      'Choose a registered federation trust anchor, or fix the value in DCQL JSON.'
    );
    expect(trustError([{ type: 'openid_federation', values: ['https://ta.example'] }])).toBeNull();
  });
});
