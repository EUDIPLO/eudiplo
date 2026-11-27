import { effectiveRoles, Role } from "../../auth/roles/role.enum.js";
import type { ConfigResourceKind } from "./config-resource.types.js";

/**
 * The role that holds the tenant's configuration bundles and therefore every
 * kind; `tenants:manage` implies it.
 */
const CONFIG_ADMIN_ROLE = Role.TenantAdmin;

/**
 * Roles of the management endpoints that change each kind, besides the admin
 * roles. `config-resource-access.spec.ts` compares them with the controllers.
 */
const CONFIG_RESOURCE_MANAGE_ROLES: Record<
    ConfigResourceKind,
    readonly Role[]
> = {
    // Session and status list settings are stored on the tenant.
    Tenant: [Role.Issuances, Role.Presentations],
    Client: [Role.Clients],
    KmsConfig: [Role.KeysExport],
    KeyChain: [Role.Keys],
    KeyChainDefaults: [Role.Keys],
    IssuanceConfig: [Role.Issuances],
    CredentialConfig: [Role.Issuances],
    PresentationConfig: [Role.Presentations],
    AttributeProvider: [Role.Issuances],
    WebhookEndpoint: [Role.Issuances, Role.Presentations],
    TrustList: [Role.Issuances, Role.Presentations],
    FederationTrustAnchor: [Role.Issuances, Role.Presentations],
    StatusList: [Role.Issuances],
};

/**
 * Whether a token may read the ownership of a kind: it needs a role that can
 * change resources of that kind, so a client can lock file-managed resources
 * before a write fails with 409.
 */
export function mayReadConfigOwnership(
    roles: readonly Role[] | undefined,
    kind: ConfigResourceKind,
): boolean {
    const allowed = new Set<string>([
        CONFIG_ADMIN_ROLE,
        ...CONFIG_RESOURCE_MANAGE_ROLES[kind],
    ]);
    return effectiveRoles(roles ?? []).some((role) => allowed.has(role));
}

/**
 * Whether a token may export one resource of a kind as a configuration
 * document. A key chain document carries the private keys of keys held in
 * the database, so it needs `keys:export`, the role of the key export. The
 * other kinds follow {@link mayReadConfigOwnership}.
 */
export function mayExportConfigDocument(
    roles: readonly Role[] | undefined,
    kind: ConfigResourceKind,
): boolean {
    if (kind === "KeyChain") {
        return effectiveRoles(roles ?? []).includes(Role.KeysExport);
    }
    return mayReadConfigOwnership(roles, kind);
}
