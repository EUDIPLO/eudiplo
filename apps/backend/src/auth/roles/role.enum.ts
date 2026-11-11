/**
 * Enumeration of all roles available in the system. The member comments are
 * the role descriptions of the generated docs (apps/docs/scripts/generate-roles-docs.ts).
 */
export enum Role {
    // to manage verifier resources: presentation configurations, trust lists, federation trust anchors, key chains, webhook endpoints and session settings
    Presentations = "presentation:manage",
    // to create presentation requests, read presentation configurations and read, cancel or delete presentation sessions
    PresentationRequest = "presentation:request",
    // to manage issuer resources: credential and issuance configurations, attribute providers, status lists and their settings, trust lists, federation trust anchors, key chains, webhook endpoints and session settings, to revoke, suspend or reinstate issued credentials, and, together with registrar:manage, to publish schema metadata at the registrar
    Issuances = "issuance:manage",
    // to create credential offers, complete or fail deferred issuance, read, cancel or delete issuance sessions and read the status of their credentials
    IssuanceOffer = "issuance:offer",
    // to manage the tenant's API clients with the roles the caller may grant, and read its audit log
    Clients = "clients:manage",
    // to manage the tenant's human users with the roles the caller may grant
    Users = "users:manage",
    // platform operator role, needs no tenant: to create, change and delete any tenant, rotate client secrets, see the cached status lists and clear the trust list, federation and status list caches of all tenants, and use a tenant's configuration bundles, key export and KMS provider settings
    Tenants = "tenants:manage",
    // to manage the current tenant's full configuration: configuration bundles, key export and KMS provider settings; a caller with it may grant every role except tenants:manage and tenant:admin
    TenantAdmin = "tenant:admin",
    // to manage the registrar configuration, enroll access certificates, create access key chains enrolled at the registrar, and list, update, deprecate and delete schema metadata at the registrar; publishing it also needs issuance:manage
    Registrar = "registrar:manage",
    // to read the tenant's audit log
    AuditRead = "audit:read",
    // to read the tenant's issuance and presentation sessions, their logs, events and statistics and the status of issued credentials, without creating, cancelling or deleting them
    SessionsRead = "sessions:read",
    // to revoke, suspend or reinstate the credentials issued in a session and read their status
    CredentialStatus = "credentials:status",
    // to create, import, rotate, change and delete key chains and read them and the KMS providers; key export and KMS provider settings need tenant:admin or tenants:manage
    Keys = "keys:manage",
}

/**
 * List of all roles
 */
export const allRoles = [
    Role.Tenants,
    Role.IssuanceOffer,
    Role.Issuances,
    Role.PresentationRequest,
    Role.Presentations,
    Role.Clients,
    Role.Users,
    Role.Registrar,
    Role.TenantAdmin,
    Role.AuditRead,
    Role.SessionsRead,
    Role.CredentialStatus,
    Role.Keys,
];

/**
 * Whether a role name is an EUDIPLO role, unlike for example a Keycloak realm
 * role such as `default-roles-<realm>`.
 */
export function isRole(name: unknown): name is Role {
    return allRoles.includes(name as Role);
}
