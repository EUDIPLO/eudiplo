import Ajv from 'ajv/dist/2020';
import {
  ClaimFieldDefinitionDto,
  UnsupportedConstraint,
  buildJsonSchema,
  flattenFields,
  unsupportedConstraints,
} from '@eudiplo/sdk-core';

/** A JSON pointer as the user typed it, e.g. `items › x-ui/hint` or `anyOf › entry 2`. */
function readablePointer(pointer: string): string {
  return pointer
    .slice(1)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
    .map((segment) => (/^\d+$/.test(segment) ? `entry ${Number(segment) + 1}` : segment))
    .join(' › ');
}

const WRONG_KIND: Record<Exclude<UnsupportedConstraint['reason'], 'unknown-keyword'>, string> = {
  'not-a-schema': 'must be a schema object or true/false',
  'not-a-list': 'must be a list of schemas',
  'not-a-map': 'must be an object of schemas',
};

/**
 * Why a claim's `constraints` would be refused on save, or undefined when every key is a
 * JSON Schema keyword the constraints accept and every value under a subschema keyword has
 * the right kind.
 */
export function unsupportedConstraintsError(constraints: unknown): string | undefined {
  if (!constraints || typeof constraints !== 'object' || Array.isArray(constraints)) {
    return 'Enter a JSON object, e.g. { "pattern": "^[A-Z]{2}$" }.';
  }
  const unsupported = unsupportedConstraints(constraints);
  const unknown = unsupported.filter(({ reason }) => reason === 'unknown-keyword');
  if (unknown.length > 0) {
    return `Not a supported JSON Schema keyword: ${unknown
      .map(({ pointer }) => readablePointer(pointer))
      .join(', ')}. Use keywords such as pattern, maxLength or items.`;
  }
  const [wrongKind] = unsupported;
  if (!wrongKind || wrongKind.reason === 'unknown-keyword') return undefined;
  return `${readablePointer(wrongKind.pointer)} ${WRONG_KIND[wrongKind.reason]}.`;
}

/**
 * Why issuance could not use the claim schema derived from these fields, or undefined when it
 * compiles. Constraints the save would refuse are named first; issuance compiles the rest with
 * the same options, so an invalid pattern or a keyword the field type does not allow is caught
 * before saving, not at the first offer.
 */
export function claimSchemaError(fields: ClaimFieldDefinitionDto[]): string | undefined {
  // The form validates each claim's constraints already; this repeats it for callers that
  // pass fields from elsewhere, because the derived schema would silently leave them out.
  for (const field of flattenFields(fields as Parameters<typeof flattenFields>[0])) {
    const refused =
      field.constraints === undefined ? undefined : unsupportedConstraintsError(field.constraints);
    if (refused) {
      return `Claim ${field.path.map((segment) => segment ?? '*').join('.')}: ${refused}`;
    }
  }
  const ajv = new Ajv({ allErrors: true, strict: true, useDefaults: true, validateSchema: false });
  try {
    ajv.compile(buildJsonSchema(fields as Parameters<typeof buildJsonSchema>[0]));
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}
