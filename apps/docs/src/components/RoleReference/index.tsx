import React from "react";
import rolesModel from "@site/docs/_generated/roles.json";

interface RoleDoc {
    name: string;
    value: string;
    description: string;
}

interface EndpointDoc {
    method: string;
    path: string;
    roles: string[];
}

const model = rolesModel as { roles: RoleDoc[]; endpoints: EndpointDoc[] };

/** Merge endpoints that share a path and accepted roles into one row (`GET, POST`). */
function endpointRows(): EndpointDoc[] {
    const rows = new Map<string, EndpointDoc>();
    for (const endpoint of model.endpoints) {
        const key = `${endpoint.path}|${endpoint.roles.join(",")}`;
        const row = rows.get(key);
        if (row) {
            row.method = `${row.method}, ${endpoint.method}`;
        } else {
            rows.set(key, { ...endpoint });
        }
    }
    return [...rows.values()];
}

/**
 * Roles and role-protected management endpoints, generated at build time by
 * apps/docs/scripts/generate-roles-docs.ts from the backend's role enum and
 * the @Secured decorators of its controllers.
 */
export default function RoleReference({ table }: { table: "roles" | "endpoints" }): React.ReactElement {
    if (model.roles.length === 0) {
        throw new Error("RoleReference: no roles generated. Run the docs prebuild.");
    }
    if (table === "roles") {
        return (
            <table>
                <thead>
                    <tr>
                        <th>Role</th>
                        <th>Description</th>
                        <th>Endpoints</th>
                    </tr>
                </thead>
                <tbody>
                    {model.roles.map((role) => (
                        <tr key={role.value}>
                            <td>
                                <code>{role.value}</code>
                            </td>
                            <td>{role.description}</td>
                            <td>{model.endpoints.filter((endpoint) => endpoint.roles.includes(role.value)).length}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        );
    }
    return (
        <table>
            <thead>
                <tr>
                    <th>Method</th>
                    <th>Path</th>
                    <th>Accepted roles</th>
                </tr>
            </thead>
            <tbody>
                {endpointRows().map((row) => (
                    <tr key={`${row.path}|${row.roles.join(",")}`}>
                        <td>{row.method}</td>
                        <td>
                            <code>{row.path}</code>
                        </td>
                        <td>
                            {row.roles.length === 0
                                ? "any valid access token"
                                : row.roles.map((role, index) => (
                                      <React.Fragment key={role}>
                                          {index > 0 && " or "}
                                          <code>{role}</code>
                                      </React.Fragment>
                                  ))}
                        </td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}
