import Ajv from 'ajv/dist/2020';
import { ClaimFieldDefinitionDto, buildJsonSchema } from '@eudiplo/sdk-core';

/**
 * Why issuance could not use the claim schema derived from these fields, or undefined when it
 * compiles. Issuance compiles it with the same options, so a misspelled keyword, an invalid
 * pattern or a keyword the field type does not allow is caught before saving, not at the first
 * offer.
 */
export function claimSchemaError(fields: ClaimFieldDefinitionDto[]): string | undefined {
  const ajv = new Ajv({ allErrors: true, strict: true, useDefaults: true, validateSchema: false });
  try {
    ajv.compile(buildJsonSchema(fields as Parameters<typeof buildJsonSchema>[0]));
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}
