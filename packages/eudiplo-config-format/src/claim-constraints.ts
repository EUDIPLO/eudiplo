// JSON Schema 2020-12 keywords a credential configuration's claim field
// `constraints` may carry (CredentialConfig v3). Anything else is refused on
// write and dropped when the backend derives the claims schema: form renderers
// read their own keys from that schema (formly's `widget.formlyConfig` can
// inject trusted HTML into the Web Client), and claims are validated with
// strict AJV, which refuses unknown keywords. The SDK keeps a copy in
// packages/eudiplo-sdk-core/src/config/constraints.ts.

/** Keywords whose value is data, kept as-is. */
export const CONSTRAINT_VALUE_KEYWORDS = [
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
] as const;

/** Keywords holding one subschema. */
export const CONSTRAINT_SCHEMA_KEYWORDS = [
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
] as const;

/** Keywords holding a list of subschemas. */
export const CONSTRAINT_SCHEMA_LIST_KEYWORDS = [
    "prefixItems",
    "allOf",
    "anyOf",
    "oneOf",
] as const;

/** Keywords holding a map of subschemas. */
export const CONSTRAINT_SCHEMA_MAP_KEYWORDS = [
    "properties",
    "patternProperties",
    "dependentSchemas",
] as const;

const VALUE_KEYWORDS = new Set<string>(CONSTRAINT_VALUE_KEYWORDS);
const SCHEMA_KEYWORDS = new Set<string>(CONSTRAINT_SCHEMA_KEYWORDS);
const SCHEMA_LIST_KEYWORDS = new Set<string>(CONSTRAINT_SCHEMA_LIST_KEYWORDS);
const SCHEMA_MAP_KEYWORDS = new Set<string>(CONSTRAINT_SCHEMA_MAP_KEYWORDS);

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pointer(path: string, segment: string | number): string {
    return `${path}/${String(segment).replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

function sanitizeSchema(
    value: unknown,
    path: string,
    removed: string[],
): Record<string, unknown> | boolean | undefined {
    if (typeof value === "boolean") {
        return value;
    }
    if (!isPlainObject(value)) {
        removed.push(path);
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
                    .map((schema, index) =>
                        sanitizeSchema(
                            schema,
                            pointer(childPath, index),
                            removed,
                        ),
                    )
                    .filter((schema) => schema !== undefined),
            ]);
        } else if (SCHEMA_MAP_KEYWORDS.has(key) && isPlainObject(child)) {
            entries.push([
                key,
                Object.fromEntries(
                    Object.entries(child)
                        .map(
                            ([name, schema]) =>
                                [
                                    name,
                                    sanitizeSchema(
                                        schema,
                                        pointer(childPath, name),
                                        removed,
                                    ),
                                ] as const,
                        )
                        .filter(([, schema]) => schema !== undefined),
                ),
            ]);
        } else {
            removed.push(childPath);
        }
    }
    return Object.fromEntries(entries);
}

/**
 * Keeps only the JSON Schema validation and annotation keywords of a claim
 * field's `constraints`, recursively for subschemas. `removed` lists the JSON
 * pointers, relative to `constraints`, of what was dropped.
 */
export function sanitizeClaimConstraints(constraints: unknown): {
    constraints: Record<string, unknown>;
    removed: string[];
} {
    const removed: string[] = [];
    const schema = sanitizeSchema(constraints, "", removed);
    return {
        constraints: isPlainObject(schema) ? schema : {},
        removed,
    };
}

/**
 * Applies `sanitizeClaimConstraints` to the `constraints` of every claim field
 * definition, recursively through `children`. `removed` lists the JSON
 * pointers of what was dropped, starting with `path` (the pointer of the
 * `fields` array).
 */
export function sanitizeClaimFields(
    fields: unknown[],
    path = "",
): { fields: unknown[]; removed: string[] } {
    const removed: string[] = [];
    const sanitized = fields.map((field, index) => {
        if (!isPlainObject(field)) return field;
        const fieldPath = pointer(path, index);
        let next = field;
        if (isPlainObject(field.constraints)) {
            const result = sanitizeClaimConstraints(field.constraints);
            if (result.removed.length > 0) {
                next = { ...next, constraints: result.constraints };
                removed.push(
                    ...result.removed.map(
                        (removedPath) =>
                            `${fieldPath}/constraints${removedPath}`,
                    ),
                );
            }
        }
        if (Array.isArray(field.children)) {
            const children = sanitizeClaimFields(
                field.children,
                pointer(fieldPath, "children"),
            );
            if (children.removed.length > 0) {
                next = { ...next, children: children.fields };
                removed.push(...children.removed);
            }
        }
        return next;
    });
    return { fields: sanitized, removed };
}
