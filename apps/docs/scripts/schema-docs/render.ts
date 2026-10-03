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
    /** Set for fields that only exist in one shape of a union, e.g. `shape 1 of 2`. */
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

function childRows(field: SchemaField, path: string, depth: number, variant?: string): SchemaTableRow[] {
    if (field.variants) {
        return orderedVariants(field).flatMap((shape, index, shapes) =>
            childRows(shape, path, depth, `shape ${index + 1} of ${shapes.length}`),
        );
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
