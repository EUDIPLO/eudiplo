import type { JsonSchema } from "./types";

// JSON Schema 2020-12 keywords a claim field's `constraints` may carry. Anything
// else is dropped: form renderers read their own keys from the schema (formly's
// `widget.formlyConfig` can inject trusted HTML), and the backend validates
// with strict AJV, which refuses unknown keywords. Copy of
// packages/eudiplo-config-format/src/claim-constraints.ts, which the backend
// uses and which this published package cannot depend on;
// test/constraints-parity.spec.ts keeps both in step.

/** Keywords whose value is data, kept as-is. */
export const VALUE_KEYWORDS = new Set([
  "type",
  "enum",
  "const",
  "multipleOf",
  "maximum",
  "exclusiveMaximum",
  "minimum",
  "exclusiveMinimum",
  "maxLength",
  "minLength",
  "pattern",
  "maxItems",
  "minItems",
  "uniqueItems",
  "maxContains",
  "minContains",
  "maxProperties",
  "minProperties",
  "required",
  "dependentRequired",
  "title",
  "description",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "$comment",
]);

/** Keywords holding one subschema. */
export const SCHEMA_KEYWORDS = new Set([
  "items",
  "contains",
  "additionalProperties",
  "propertyNames",
  "not",
  "if",
  "then",
  "else",
  "unevaluatedItems",
  "unevaluatedProperties",
]);

/** Keywords holding a list of subschemas. */
export const SCHEMA_LIST_KEYWORDS = new Set(["prefixItems", "allOf", "anyOf", "oneOf"]);

/** Keywords holding a map of subschemas. */
export const SCHEMA_MAP_KEYWORDS = new Set([
  "properties",
  "patternProperties",
  "dependentSchemas",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeSchema(value: unknown): JsonSchema | boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (!isPlainObject(value)) {
    return undefined;
  }

  // Object.fromEntries defines own properties, so a "__proto__" key stays data
  const entries: [string, unknown][] = [];
  for (const [key, child] of Object.entries(value)) {
    if (VALUE_KEYWORDS.has(key)) {
      entries.push([key, child]);
    } else if (SCHEMA_KEYWORDS.has(key)) {
      const schema = sanitizeSchema(child);
      if (schema !== undefined) {
        entries.push([key, schema]);
      }
    } else if (SCHEMA_LIST_KEYWORDS.has(key) && Array.isArray(child)) {
      entries.push([
        key,
        child.map(sanitizeSchema).filter((schema) => schema !== undefined),
      ]);
    } else if (SCHEMA_MAP_KEYWORDS.has(key) && isPlainObject(child)) {
      entries.push([
        key,
        Object.fromEntries(
          Object.entries(child)
            .map(([name, schema]) => [name, sanitizeSchema(schema)] as const)
            .filter(([, schema]) => schema !== undefined),
        ),
      ]);
    }
  }
  return Object.fromEntries(entries) as JsonSchema;
}

/**
 * Keeps only the JSON Schema validation and annotation keywords of a field's
 * `constraints`, recursively for subschemas. Unknown keywords are dropped.
 */
export function sanitizeConstraints(constraints: unknown): JsonSchema {
  const schema = sanitizeSchema(constraints);
  return isPlainObject(schema) ? schema : {};
}
