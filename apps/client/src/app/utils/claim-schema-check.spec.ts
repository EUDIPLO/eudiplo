import { describe, expect, it } from 'vitest';
import { claimSchemaError } from './claim-schema-check';

describe('claimSchemaError', () => {
  it('accepts constraints issuance can compile, including object keywords met by children', () => {
    expect(
      claimSchemaError([
        { path: ['birthdate'], type: 'string', constraints: { pattern: '^\\d{4}$' } },
        { path: ['nationalities'], type: 'array', constraints: { items: { type: 'string' } } },
        // `required` names a property that a child field defines.
        {
          path: ['address'],
          type: 'object',
          constraints: { required: ['city'] },
          children: [{ path: ['city'], type: 'string' }],
        },
      ])
    ).toBeUndefined();
  });

  it('names what issuance would refuse', () => {
    expect(
      claimSchemaError([{ path: ['code'], type: 'string', constraints: { patern: '^a$' } }])
    ).toContain('unknown keyword: "patern"');
    expect(
      claimSchemaError([{ path: ['code'], type: 'string', constraints: { pattern: '^[' } }])
    ).toBeDefined();
    expect(
      claimSchemaError([{ path: ['code'], type: 'string', constraints: { items: {} } }])
    ).toContain('strictTypes');
    expect(
      claimSchemaError([
        { path: ['code'], type: 'string', constraints: { additionalProperties: false } },
      ])
    ).toContain('missing type "object"');
  });
});
