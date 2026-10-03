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

function fieldFromJsonSchema(schema: JsonSchema, required: boolean): SchemaField {
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
