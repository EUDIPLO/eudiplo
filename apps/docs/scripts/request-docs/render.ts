import type { RequestField } from "./model.js";

function orderedVariants(field: RequestField): RequestField[] {
    return [...(field.variants ?? [])].sort(
        (a, b) => JSON.stringify(example(b)).length - JSON.stringify(example(a)).length,
    );
}

function example(field: RequestField): unknown {
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

/** Render an annotated, syntactically valid JSONC sample from the serialized DTO model. */
export function renderRequestBody(field: RequestField, depth = 0): string {
    if (field.variants) return renderRequestBody(orderedVariants(field)[0], depth);
    const pad = "    ".repeat(depth);
    if (field.properties) {
        const entries = Object.entries(field.properties);
        const lines = entries.flatMap(([name, child], index) => {
            const notes = [child.required ? "required" : "optional", child.type];
            if (child.enum) notes.push(`allowed: ${child.enum.join(" | ")}`);
            if (child.minimum !== undefined) notes.push(`minimum: ${child.minimum}`);
            if (child.description) notes.push(child.description);
            const alternatives = child.variants && orderedVariants(child).slice(1).map(
                (variant) => `${pad}    // Alternative for ${name}: ${JSON.stringify(example(variant))}`,
            ) || [];
            return [
                `${pad}    // ${notes.join("; ")}`,
                `${pad}    ${JSON.stringify(name)}: ${renderRequestBody(child, depth + 1)}${index < entries.length - 1 ? "," : ""}`,
                ...alternatives,
            ];
        });
        return ["{", ...lines, `${pad}}`].join("\n");
    }
    if (field.type === "array") {
        if (!field.items) return "[]";
        return `[\n${pad}    ${renderRequestBody(field.items, depth + 1)}\n${pad}]`;
    }
    return JSON.stringify(example(field));
}
