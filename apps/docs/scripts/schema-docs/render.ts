import type { SchemaField } from "./model.js";

function orderedVariants(field: SchemaField): SchemaField[] {
    return [...(field.variants ?? [])].sort(
        (a, b) => JSON.stringify(example(b)).length - JSON.stringify(example(a)).length,
    );
}

function example(field: SchemaField): unknown {
    if (field.variants) return example(orderedVariants(field)[0]);
    if (field.properties) {
        return Object.fromEntries(
            Object.entries(field.properties).map(([name, child]) => [name, example(child)]),
        );
    }
    if (field.type === "array") return field.items ? [example(field.items)] : [];
    if (field.enum) return field.enum[0];
    if (field.type === "number" || field.type === "integer") return field.minimum ?? 0;
    if (field.type === "boolean") return false;
    if (field.type === "string") return "string";
    return {};
}

/** Render an annotated, syntactically valid JSONC sample (`mode="body"`). */
export function renderSchemaBody(field: SchemaField, depth = 0): string {
    if (field.variants) return renderSchemaBody(orderedVariants(field)[0], depth);
    const pad = "    ".repeat(depth);
    if (field.properties) {
        const entries = Object.entries(field.properties);
        const lines = entries.flatMap(([name, child], index) => {
            const notes = [
                child.required ? "required" : "optional",
                child.nullable ? `${child.type} or null` : child.type,
            ];
            if (child.enum) notes.push(`allowed: ${child.enum.join(" | ")}`);
            if (child.minimum !== undefined) notes.push(`minimum: ${child.minimum}`);
            if (child.description) notes.push(child.description);
            const alternatives = child.variants && orderedVariants(child).slice(1).map(
                (variant) => `${pad}    // Alternative for ${name}: ${JSON.stringify(example(variant))}`,
            ) || [];
            return [
                `${pad}    // ${notes.join("; ")}`,
                `${pad}    ${JSON.stringify(name)}: ${renderSchemaBody(child, depth + 1)}${index < entries.length - 1 ? "," : ""}`,
                ...alternatives,
            ];
        });
        return ["{", ...lines, `${pad}}`].join("\n");
    }
    if (field.type === "array") {
        if (!field.items) return "[]";
        return `[\n${pad}    ${renderSchemaBody(field.items, depth + 1)}\n${pad}]`;
    }
    return JSON.stringify(example(field));
}

/** One row of the nested field table (`mode="table"`). */
export interface SchemaTableRow {
    /** Dotted field path; array items are written as `name[]`. */
    path: string;
    /** Nesting level of the field, 0 for top-level fields. */
    depth: number;
    required: boolean;
    /** Type label, e.g. `string`, `array of object`, `one of 2 shapes`. */
    type: string;
    allowed?: string[];
    minimum?: number;
    description?: string;
    /** Set for fields that only exist in one shape of a union, e.g. "when `format` is `mso_mdoc`". */
    variant?: string;
}

function typeLabel(field: SchemaField): string {
    return field.nullable ? `${baseTypeLabel(field)} or null` : baseTypeLabel(field);
}

function baseTypeLabel(field: SchemaField): string {
    if (field.variants) return `one of ${field.variants.length} shapes`;
    if (field.type === "array") return `array of ${field.items ? typeLabel(field.items) : "unknown"}`;
    if (field.type === "unknown") return "any";
    return field.type;
}

/**
 * The property that tells the shapes of a union apart (a single allowed value
 * per shape, different in every shape), for example `format` or `type`.
 */
function discriminator(shapes: SchemaField[]): { name: string; values: string[] } | undefined {
    for (const name of Object.keys(shapes[0]?.properties ?? {})) {
        const values = shapes.map((shape) => {
            const allowed = shape.properties?.[name]?.enum;
            return allowed?.length === 1 ? String(allowed[0]) : undefined;
        });
        if (values.every((value) => value !== undefined) && new Set(values).size === values.length) {
            return { name, values: values as string[] };
        }
    }
    return undefined;
}

function pickProperties(field: SchemaField, keep: (name: string) => boolean): SchemaField {
    return {
        ...field,
        properties: Object.fromEntries(Object.entries(field.properties ?? {}).filter(([name]) => keep(name))),
    };
}

function unionRows(field: SchemaField, path: string, depth: number, variant?: string): SchemaTableRow[] {
    const shapes = orderedVariants(field);
    const key = discriminator(shapes);
    // Fields that every shape has in the same form are listed once.
    const common = new Set(
        Object.keys(shapes[0].properties ?? {}).filter(
            (name) =>
                name !== key?.name &&
                shapes.every(
                    (shape) =>
                        shape.properties?.[name] !== undefined &&
                        JSON.stringify(shape.properties[name]) === JSON.stringify(shapes[0].properties?.[name]),
                ),
        ),
    );
    const label = (index: number) =>
        key ? `when \`${key.name}\` is \`${key.values[index]}\`` : `in shape ${index + 1} of ${shapes.length}`;
    return [
        ...(common.size > 0 ? childRows(pickProperties(shapes[0], (name) => common.has(name)), path, depth, variant) : []),
        ...shapes.flatMap((shape, index) =>
            childRows(pickProperties(shape, (name) => !common.has(name)), path, depth, label(index)),
        ),
    ];
}

function childRows(field: SchemaField, path: string, depth: number, variant?: string): SchemaTableRow[] {
    if (field.variants) {
        return unionRows(field, path, depth, variant);
    }
    if (field.type === "array" && field.items) {
        return childRows(field.items, `${path}[]`, depth, variant);
    }
    return Object.entries(field.properties ?? {}).flatMap(([name, child]) => {
        const childPath = path ? `${path}.${name}` : name;
        // For arrays of enum values, list the values allowed in the array.
        const allowed = child.enum ?? (child.type === "array" ? child.items?.enum : undefined);
        const row: SchemaTableRow = {
            path: childPath,
            depth,
            required: child.required,
            type: typeLabel(child),
            ...(allowed ? { allowed: allowed.map(String) } : {}),
            ...(child.minimum !== undefined ? { minimum: child.minimum } : {}),
            ...(child.description ? { description: child.description } : {}),
            ...(variant ? { variant } : {}),
        };
        return [row, ...childRows(child, childPath, depth + 1, variant)];
    });
}

/** Flatten a schema model into table rows: every nested field with path, required, type and description. */
export function schemaTableRows(field: SchemaField): SchemaTableRow[] {
    return childRows(field, "", 0);
}
