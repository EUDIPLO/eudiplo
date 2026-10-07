import { z } from "zod";

/** Serializable docs tree for one field of a Zod schema (the root is the schema itself). */
export interface SchemaField {
    type: string;
    required: boolean;
    description?: string;
    enum?: unknown[];
    minimum?: number;
    properties?: Record<string, SchemaField>;
    items?: SchemaField;
    variants?: SchemaField[];
    /** The field also accepts `null` (shown as "or null"). */
    nullable?: boolean;
}

type JsonSchema = {
    type?: string | string[];
    description?: string;
    enum?: unknown[];
    const?: unknown;
    minimum?: number;
    properties?: Record<string, JsonSchema>;
    required?: string[];
    items?: JsonSchema;
    oneOf?: JsonSchema[];
    anyOf?: JsonSchema[];
};

/** A union whose branches are all the same plain scalar type (e.g. a string or a `${ENV}` placeholder string). */
function scalarUnionType(variants: JsonSchema[] | undefined): string | undefined {
    const [first] = variants ?? [];
    const plain = (variant: JsonSchema) =>
        typeof variant.type === "string" &&
        variant.type !== "object" &&
        variant.type !== "array" &&
        variant.const === undefined &&
        variant.enum === undefined;
    return first && typeof first.type === "string" && variants?.every((variant) => plain(variant) && variant.type === first.type)
        ? first.type
        : undefined;
}

/**
 * Moves `null` out of the type: `type: ["string", "null"]` and a `null` branch
 * of a union both become the remaining type plus `nullable`.
 */
function withoutNull(schema: JsonSchema): { schema: JsonSchema; nullable: boolean } {
    if (Array.isArray(schema.type) && schema.type.includes("null")) {
        const types = schema.type.filter((type) => type !== "null");
        return {
            schema: { ...schema, type: types.length === 1 ? types[0] : types.join(" | ") },
            nullable: true,
        };
    }
    const variants = schema.oneOf ?? schema.anyOf;
    const nonNull = variants?.filter((variant) => variant.type !== "null");
    if (!variants || !nonNull || nonNull.length === variants.length) {
        return { schema, nullable: false };
    }
    const { oneOf: _oneOf, anyOf: _anyOf, ...rest } = schema;
    if (nonNull.length === 1) {
        // Keep the parent's description, which Zod puts on the union.
        return {
            schema: { ...nonNull[0], ...(rest.description ? { description: rest.description } : {}) },
            nullable: true,
        };
    }
    return { schema: { ...rest, anyOf: nonNull }, nullable: true };
}

function fieldFromJsonSchema(input: JsonSchema, required: boolean): SchemaField {
    const { schema, nullable } = withoutNull(input);
    if (nullable) {
        return { ...fieldFromJsonSchema(schema, required), nullable: true };
    }
    const scalarType = scalarUnionType(schema.oneOf ?? schema.anyOf);
    if (scalarType) {
        return fieldFromJsonSchema({ ...schema, type: scalarType, oneOf: undefined, anyOf: undefined }, required);
    }
    const variants = schema.oneOf ?? schema.anyOf;
    const allowed = variants?.every(
        (variant) => variant.const !== undefined && variant.type === "string",
    )
        ? variants.map((variant) => variant.const)
        : undefined;
    return {
        type: allowed
            ? "string"
            : ((Array.isArray(schema.type) ? schema.type.join(" | ") : schema.type) ??
              (variants ? "union" : "unknown")),
        required,
        ...(schema.description ? { description: schema.description } : {}),
        ...(schema.enum ? { enum: schema.enum } : {}),
        ...(allowed ? { enum: allowed } : {}),
        ...(schema.const !== undefined ? { enum: [schema.const] } : {}),
        ...(schema.minimum !== undefined ? { minimum: schema.minimum } : {}),
        ...(schema.properties
            ? {
                  properties: Object.fromEntries(
                      Object.entries(schema.properties).map(([name, child]) => [
                          name,
                          fieldFromJsonSchema(child, schema.required?.includes(name) ?? false),
                      ]),
                  ),
              }
            : {}),
        ...(schema.items ? { items: fieldFromJsonSchema(schema.items, true) } : {}),
        ...(variants && !allowed ? { variants: variants.map((item) => fieldFromJsonSchema(item, true)) } : {}),
    };
}

/** Convert a Zod schema (the same one the backend validates with) into a serializable docs tree. */
export function buildSchemaModel(schema: z.ZodType): SchemaField {
    return fieldFromJsonSchema(
        z.toJSONSchema(schema, { unrepresentable: "any", reused: "inline" }) as JsonSchema,
        true,
    );
}

/**
 * Replaces the description of fields by path (`a.b`; arrays and nullable
 * wrappers are crossed implicitly). Throws for a path that does not exist, so
 * a renamed field cannot leave a stale override behind.
 */
export function overrideDescriptions(model: SchemaField, descriptions: Record<string, string>): SchemaField {
    for (const [path, description] of Object.entries(descriptions)) {
        let field: SchemaField | undefined = model;
        for (const name of path.split(".")) {
            while (field?.items) field = field.items;
            field = field?.properties?.[name];
        }
        if (!field) {
            throw new Error(`Description override for unknown field "${path}"`);
        }
        field.description = description;
    }
    return model;
}
