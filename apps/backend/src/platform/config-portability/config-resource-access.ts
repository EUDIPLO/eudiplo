import { Role } from "../../auth/roles/role.enum.js";
import type { ConfigResourceKind } from "./config-resource.types.js";

/** Roles that hold the tenant's configuration bundles and therefore every kind. */
const CONFIG_ADMIN_ROLES: readonly Role[] = [Role.Tenants, Role.TenantAdmin];

/**
 * Roles of the management endpoints that change each kind, besides the admin
 * roles. `config-resource-access.spec.ts` compares them with the controllers.
 */
const CONFIG_RESOURCE_MANAGE_ROLES: Record<
    ConfigResourceKind,
    readonly Role[]
> = {
    // Session and status list settings and the default access key chain are
    // stored on the tenant.
    Tenant: [Role.Issuances, Role.Presentations, Role.Keys],
    Client: [Role.Clients],
    KmsConfig: [],
    KeyChain: [Role.Issuances, Role.Presentations, Role.Keys],
    RegistrarConfig: [Role.Registrar],
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
    const allowed = new Set([
        ...CONFIG_ADMIN_ROLES,
        ...CONFIG_RESOURCE_MANAGE_ROLES[kind],
    ]);
    return (roles ?? []).some((role) => allowed.has(role));
}

/**
 * Whether a token may export one resource of a kind as a configuration
 * document. A key chain document carries the private keys of keys held in
 * the database, so it needs the roles of the key export. A tenant document
 * also carries the session and status list settings, which `keys:manage`
 * cannot read, so that role only reads its ownership. The other kinds follow
 * {@link mayReadConfigOwnership}.
 */
export function mayExportConfigDocument(
    roles: readonly Role[] | undefined,
    kind: ConfigResourceKind,
): boolean {
    if (kind === "KeyChain") {
        return (roles ?? []).some((role) => CONFIG_ADMIN_ROLES.includes(role));
    }
    if (kind === "Tenant") {
        return mayReadConfigOwnership(
            roles?.filter((role) => role !== Role.Keys),
            kind,
        );
    }
    return mayReadConfigOwnership(roles, kind);
}
