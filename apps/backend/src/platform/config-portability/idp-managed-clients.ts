import type { AuthSettings } from "../../auth/auth-settings.js";
import { ClientsManagedByIdentityProvider } from "../../auth/client/domain/client-data.js";
import type { ConfigMigrationIssue } from "./config-resource.types.js";

/**
 * With `OIDC_PROVIDER=generic`, the identity provider manages the clients, so
 * configuration bundles and config folders neither carry nor change them.
 * Client records left from an earlier mode stay as they are: they only add
 * limits to the tokens of their client.
 */
export const CLIENT_MANAGED_BY_IDENTITY_PROVIDER =
    "CLIENT_MANAGED_BY_IDENTITY_PROVIDER";

/** Whether the identity provider manages the clients (`OIDC_PROVIDER=generic`). */
export function clientsManagedByIdentityProvider(
    settings: AuthSettings,
): boolean {
    return settings.mode === "generic";
}

const MANAGED = ClientsManagedByIdentityProvider.MESSAGE;

/** Blocks a `Client` document, which the import could not apply. */
export function clientDocumentRefusal(clientId: string): ConfigMigrationIssue {
    return {
        severity: "error",
        code: CLIENT_MANAGED_BY_IDENTITY_PROVIDER,
        path: "/spec",
        message: `${MANAGED} Create the client there and remove this document; in a config folder, delete its file under clients/.`,
        resource: { kind: "Client", id: clientId },
    };
}

/** Explains why `replace` keeps a client record that its source no longer has. */
export function clientKeptWarning(clientId: string): ConfigMigrationIssue {
    return {
        severity: "warning",
        code: CLIENT_MANAGED_BY_IDENTITY_PROVIDER,
        path: "/spec",
        message: `${MANAGED} The record left from an earlier mode is not deleted and keeps its limits for the tokens of this client.`,
        resource: { kind: "Client", id: clientId },
    };
}

/** Explains why an export leaves out a client record. */
export function clientNotExportedWarning(
    clientId: string,
): ConfigMigrationIssue {
    return {
        severity: "warning",
        code: CLIENT_MANAGED_BY_IDENTITY_PROVIDER,
        path: "/spec",
        message: `${MANAGED} The record left from an earlier mode is not exported.`,
        resource: { kind: "Client", id: clientId },
    };
}
