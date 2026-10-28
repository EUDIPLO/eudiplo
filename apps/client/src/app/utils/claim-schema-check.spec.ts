import { describe, expect, it } from 'vitest';
import { claimSchemaError, unsupportedConstraintsError } from './claim-schema-check';

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
    // A misspelled keyword, as a JSON editor could hand it over
    const misspelled = JSON.parse('{ "patern": "^a$" }');
    expect(claimSchemaError([{ path: ['code'], type: 'string', constraints: misspelled }])).toBe(
      'Claim code: Not a supported JSON Schema keyword: patern. Use keywords such as pattern, maxLength or items.'
    );
    expect(
      claimSchemaError([{ path: ['list', null], type: 'string', constraints: misspelled }])
    ).toContain('Claim list.*: Not a supported JSON Schema keyword: patern.');
    expect(
      claimSchemaError([{ path: ['code'], type: 'string', constraints: JSON.parse('"abc"') }])
    ).toBe('Claim code: Enter a JSON object, e.g. { "pattern": "^[A-Z]{2}$" }.');
    expect(
      claimSchemaError([
        {
          path: ['address'],
          type: 'object',
          children: [{ path: ['city'], type: 'string', constraints: misspelled }],
        },
      ])
    ).toContain('Claim address.city: Not a supported JSON Schema keyword: patern.');
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

describe('unsupportedConstraintsError', () => {
  it('names unknown keywords as typed', () => {
    expect(
      unsupportedConstraintsError(
        JSON.parse('{ "items": { "type": "string", "x-ui/hint": 1 }, "a~b": 1, "pattern": "^a$" }')
      )
    ).toBe(
      'Not a supported JSON Schema keyword: items › x-ui/hint, a~b. Use keywords such as pattern, maxLength or items.'
    );
  });

  it('says what an allowed keyword must hold instead of calling it unsupported', () => {
    expect(unsupportedConstraintsError(JSON.parse('{ "items": "string" }'))).toBe(
      'items must be a schema object or true/false.'
    );
    expect(unsupportedConstraintsError(JSON.parse('{ "anyOf": [{ "minLength": 1 }, 3] }'))).toBe(
      'anyOf › entry 2 must be a schema object or true/false.'
    );
    expect(unsupportedConstraintsError(JSON.parse('{ "anyOf": {} }'))).toBe(
      'anyOf must be a list of schemas.'
    );
    expect(unsupportedConstraintsError(JSON.parse('{ "properties": [] }'))).toBe(
      'properties must be an object of schemas.'
    );
  });

  it('asks for an object and accepts allow-listed keywords', () => {
    expect(unsupportedConstraintsError(['pattern'])).toContain('Enter a JSON object');
    expect(
      unsupportedConstraintsError({ pattern: '^a$', items: { minLength: 1 } })
    ).toBeUndefined();
  });
});
