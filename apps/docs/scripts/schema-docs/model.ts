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
}

type JsonSchema = {
    type?: string;
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
        variant.type !== undefined &&
        variant.type !== "object" &&
        variant.type !== "array" &&
        variant.const === undefined &&
        variant.enum === undefined;
    return first && variants?.every((variant) => plain(variant) && variant.type === first.type)
        ? first.type
        : undefined;
}

function fieldFromJsonSchema(schema: JsonSchema, required: boolean): SchemaField {
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
        type: allowed ? "string" : schema.type ?? (variants ? "union" : "unknown"),
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
