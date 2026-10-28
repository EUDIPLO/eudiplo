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

/** What `buildJsonSchema` drops from a field's `constraints`, and why. */
export interface UnsupportedConstraint {
  /** JSON pointer relative to `constraints`. */
  pointer: string;
  /**
   * `unknown-keyword`: not on the allow-list. `not-a-schema`: a subschema that
   * is no object or boolean. `not-a-list` / `not-a-map`: a list or map keyword
   * (such as `anyOf` or `properties`) whose value is no array or object.
   */
  reason: "unknown-keyword" | "not-a-schema" | "not-a-list" | "not-a-map";
}

function pointer(path: string, segment: string | number): string {
  return `${path}/${String(segment).replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

function sanitizeSchema(
  value: unknown,
  path: string,
  removed: UnsupportedConstraint[],
): JsonSchema | boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (!isPlainObject(value)) {
    removed.push({ pointer: path, reason: "not-a-schema" });
    return undefined;
  }

  // Object.fromEntries defines own properties, so a "__proto__" key stays data
  const entries: [string, unknown][] = [];
  for (const [key, child] of Object.entries(value)) {
    const childPath = pointer(path, key);
    if (VALUE_KEYWORDS.has(key)) {
      entries.push([key, child]);
    } else if (SCHEMA_KEYWORDS.has(key)) {
      const schema = sanitizeSchema(child, childPath, removed);
      if (schema !== undefined) {
        entries.push([key, schema]);
      }
    } else if (SCHEMA_LIST_KEYWORDS.has(key) && Array.isArray(child)) {
      entries.push([
        key,
        child
          .map((schema, index) => sanitizeSchema(schema, pointer(childPath, index), removed))
          .filter((schema) => schema !== undefined),
      ]);
    } else if (SCHEMA_MAP_KEYWORDS.has(key) && isPlainObject(child)) {
      entries.push([
        key,
        Object.fromEntries(
          Object.entries(child)
            .map(
              ([name, schema]) =>
                [name, sanitizeSchema(schema, pointer(childPath, name), removed)] as const,
            )
            .filter(([, schema]) => schema !== undefined),
        ),
      ]);
    } else {
      removed.push({
        pointer: childPath,
        reason: SCHEMA_LIST_KEYWORDS.has(key)
          ? "not-a-list"
          : SCHEMA_MAP_KEYWORDS.has(key)
            ? "not-a-map"
            : "unknown-keyword",
      });
    }
  }
  return Object.fromEntries(entries) as JsonSchema;
}

/**
 * Keeps only the JSON Schema validation and annotation keywords of a field's
 * `constraints`, recursively for subschemas. Unknown keywords are dropped.
 */
export function sanitizeConstraints(constraints: unknown): JsonSchema {
  const schema = sanitizeSchema(constraints, "", []);
  return isPlainObject(schema) ? schema : {};
}

/**
 * What `buildJsonSchema` would drop from a field's `constraints`: keywords
 * outside the allow-list and values of the wrong kind under subschema
 * keywords. The backend refuses them on save.
 */
export function unsupportedConstraints(constraints: unknown): UnsupportedConstraint[] {
  const removed: UnsupportedConstraint[] = [];
  sanitizeSchema(constraints, "", removed);
  return removed;
}
