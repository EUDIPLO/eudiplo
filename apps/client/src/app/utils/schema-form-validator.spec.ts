import { FormControl } from '@angular/forms';
import { describe, expect, it } from 'vitest';
import { schemaFormValidator } from './schema-form-validator';
import { SchemaValidation } from './schemas';

describe('schemaFormValidator', () => {
  const validate = schemaFormValidator(
    new SchemaValidation({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { pattern: { type: 'string' } },
      additionalProperties: false,
    })
  );

  it('accepts an empty value and a valid object', () => {
    expect(validate(new FormControl(''))).toBeNull();
    expect(validate(new FormControl('{ "pattern": "^a$" }'))).toBeNull();
  });

  it('names the property that is not allowed', () => {
    expect(validate(new FormControl('{ "format": "date" }'))).toEqual({
      invalidSchema: 'data must NOT have additional properties "format"',
    });
  });

  it('names the path of a nested error', () => {
    expect(validate(new FormControl('{ "pattern": 1 }'))).toEqual({
      invalidSchema: 'data/pattern must be string',
    });
  });
});
