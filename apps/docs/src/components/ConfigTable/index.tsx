import React from "react";
import configModel from "@site/docs/_generated/config-model.json";
import InlineCode from "../InlineCode";

export interface ConfigItem {
    key: string;
    type: string;
    defaultValue?: unknown;
    defaultText?: string;
    allowedValues?: unknown[];
    description: string;
    presence: "required" | "optional" | "conditional";
    group: string;
    order: number;
    secret: boolean;
    conditions: string[];
    meta: Record<string, unknown>;
}

export interface ConfigGroup {
    name: string;
    order: number;
    items: ConfigItem[];
}

export interface ConfigModel {
    createdAt: string;
    groups: ConfigGroup[];
    all: ConfigItem[];
}

const model = configModel as ConfigModel;

/**
 * Renders the environment variables belonging to a single config group
 * (e.g. "tls", "storage") from the model produced at build time by
 * apps/docs/scripts/generate-config-docs.ts out of the backend's Joi validation schema.
 */
export default function ConfigTable({
    group,
}: {
    group: string;
}): React.ReactElement {
    const g = model.groups.find((x) => x.name === group);
    if (!g) {
        return (
            <p>
                <em>No configuration options found for group "{group}".</em>
            </p>
        );
    }

    return (
        <table>
            <thead>
                <tr>
                    <th>Key</th>
                    <th>Type</th>
                    <th>Allowed values</th>
                    <th>Notes</th>
                </tr>
            </thead>
            <tbody>
                {g.items.map((item) => (
                    <tr key={item.key}>
                        <td>
                            <code>{item.key}</code>
                        </td>
                        <td>
                            <code>{item.type}</code>
                        </td>
                        <td>
                            {item.allowedValues && item.allowedValues.length > 0
                                ? item.allowedValues.map((value, idx) => (
                                      <React.Fragment key={String(value)}>
                                          {idx > 0 && ", "}
                                          <code>{String(value)}</code>
                                      </React.Fragment>
                                  ))
                                : "-"}
                        </td>
                        <td>
                            <ConfigNotes item={item} />
                        </td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

function ConfigNotes({ item }: { item: ConfigItem }): React.ReactElement {
    return (
        <>
            <InlineCode text={item.description} />
            {item.presence === "required" && (
                <>
                    {" "}
                    <strong>[required]</strong>
                </>
            )}
            {item.presence === "optional" && (
                <>
                    {" "}
                    <strong>[optional]</strong>
                </>
            )}
            {item.defaultText !== undefined && (
                <>
                    {" "}
                    (default: <InlineCode text={item.defaultText} />)
                </>
            )}
            {item.conditions.map((c, idx) => (
                <React.Fragment key={idx}>
                    {" "}
                    [<InlineCode text={c} />]
                </React.Fragment>
            ))}
            {item.secret && <> 🔒</>}
        </>
    );
}
