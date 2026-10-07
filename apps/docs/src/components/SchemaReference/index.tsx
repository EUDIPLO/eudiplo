import React from "react";
import CodeBlock from "@theme/CodeBlock";
import models from "@site/docs/_generated/schemas";
import type { SchemaField } from "../../../scripts/schema-docs/model";
import { renderSchemaBody, schemaTableRows } from "../../../scripts/schema-docs/render";
import InlineCode from "../InlineCode";

export interface SchemaReferenceProps {
    /** Registry name from apps/docs/scripts/schema-docs/registry.ts. */
    name: string;
    /** `body`: annotated JSONC sample; `table`: nested field table. */
    mode?: "body" | "table";
    /** `table` only: show fields up to this nesting level (1 = top-level fields only). */
    maxDepth?: number;
}

/**
 * Field reference generated at build time from a backend Zod schema
 * (apps/docs/scripts/generate-schema-docs.ts).
 */
export default function SchemaReference({ name, mode = "table", maxDepth }: SchemaReferenceProps): React.ReactElement {
    const model = models[name] as SchemaField | undefined;
    if (!model) {
        // Fail the build instead of publishing an empty reference.
        throw new Error(`SchemaReference: unknown schema "${name}". Register it in apps/docs/scripts/schema-docs/registry.ts.`);
    }
    if (mode === "body") {
        // Prism's JSON5 grammar highlights JSONC comments; its JSON grammar does not.
        return <CodeBlock language="json5">{renderSchemaBody(model)}</CodeBlock>;
    }
    return (
        <table>
            <thead>
                <tr>
                    <th>Field</th>
                    <th>Required</th>
                    <th>Type / allowed values</th>
                    <th>Description</th>
                </tr>
            </thead>
            <tbody>
                {schemaTableRows(model).filter((row) => maxDepth === undefined || row.depth < maxDepth).map((row) => (
                    <tr key={`${row.path}|${row.variant ?? ""}`}>
                        <td style={{ paddingLeft: `${0.75 + row.depth * 1.25}rem`, whiteSpace: "nowrap" }}>
                            <code>{row.path}</code>
                        </td>
                        <td>{row.required ? "yes" : "no"}</td>
                        <td>
                            <code>{row.type}</code>
                            {row.allowed && (
                                <>
                                    :{" "}
                                    {row.allowed.map((value, index) => (
                                        <React.Fragment key={value}>
                                            {index > 0 && " | "}
                                            <code>{value}</code>
                                        </React.Fragment>
                                    ))}
                                </>
                            )}
                            {row.minimum !== undefined && <> (minimum {row.minimum})</>}
                        </td>
                        <td>
                            {row.variant && (
                                <em>
                                    Only <InlineCode text={row.variant} />.{" "}
                                </em>
                            )}
                            {row.description && <InlineCode text={row.description} />}
                        </td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}
