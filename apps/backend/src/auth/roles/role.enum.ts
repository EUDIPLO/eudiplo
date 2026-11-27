import {
    effectiveRoles as expandRoles,
    IMPLIED_ROLES,
} from "@eudiplo/config-format/role-model.js";

/**
 * Enumeration of all roles available in the system. The member comments are
 * the role descriptions of the generated docs (apps/docs/scripts/generate-roles-docs.ts).
 */
export enum Role {
    // to manage verifier resources: presentation configurations, OpenID Connect clients, trust lists, federation trust anchors, webhook endpoints and session settings, and, together with registrar:manage, to request a verifier registration certificate from the EUDI Hub
    Presentations = "presentation:manage",
    // to create presentation requests and read, cancel or delete presentation sessions
    PresentationRequest = "presentation:request",
    // to read verifier resources: presentation configurations, OpenID Connect clients, trust lists, federation trust anchors, webhook endpoints, session settings and key chains, without changing them
    PresentationRead = "presentation:read",
    // to manage issuer resources: credential and issuance configurations, attribute providers, status lists and their settings, trust lists, federation trust anchors, webhook endpoints and session settings, and, together with registrar:manage, to request an issuer registration certificate from the EUDI Hub
    Issuances = "issuance:manage",
    // to create credential offers, complete or fail deferred issuance, and read, cancel or delete issuance sessions and the status of their credentials
    IssuanceOffer = "issuance:offer",
    // to read issuer resources: credential and issuance configurations, issuer settings, attribute providers, status lists and their settings, trust lists, federation trust anchors, webhook endpoints, session settings and key chains, without changing them
    IssuanceRead = "issuance:read",
    // to manage the tenant's API clients with the roles the caller may grant
    Clients = "clients:manage",
    // to manage the tenant's human users with the roles the caller may grant
    Users = "users:manage",
    // platform operator role, needs no tenant: to create, change and delete any tenant, rotate client secrets, see the cached status lists and clear the trust list, federation and status list caches of all tenants; with a token of a tenant it also has every role of that tenant
    Tenants = "tenants:manage",
    // to administer the current tenant: it has every role of the tenant, uses configuration bundles and may grant every role except tenants:manage and tenant:admin
    TenantAdmin = "tenant:admin",
    // to request certificates from a registrar such as the EUDI Hub: list the organizations of a portal token and request access certificates for access key chains; registration certificates also need presentation:manage or issuance:manage
    Registrar = "registrar:manage",
    // to read the tenant's audit log
    AuditRead = "audit:read",
    // to read the tenant's issuance and presentation sessions, their logs, events and statistics and the status of issued credentials, without creating, cancelling or deleting them
    SessionsRead = "sessions:read",
    // to revoke, suspend or reinstate the credentials issued in a session and read their status
    CredentialStatus = "credentials:status",
    // to create, import, rotate, change and delete key chains, request certificate signing requests, set the default access key chain and read key chains and the KMS providers
    Keys = "keys:manage",
    // to export key chains with their private keys and to manage the tenant's KMS provider settings
    KeysExport = "keys:export",
}

/**
 * List of all roles
 */
export const allRoles = [
    Role.Tenants,
    Role.TenantAdmin,
    Role.IssuanceOffer,
    Role.Issuances,
    Role.IssuanceRead,
    Role.PresentationRequest,
    Role.Presentations,
    Role.PresentationRead,
    Role.Clients,
    Role.Users,
    Role.Registrar,
    Role.AuditRead,
    Role.SessionsRead,
    Role.CredentialStatus,
    Role.Keys,
    Role.KeysExport,
];

/**
 * Roles that each role includes directly, from the table the backend and the
 * Web Client share (`@eudiplo/config-format/role-model.js`).
 */
export const impliedRoles = IMPLIED_ROLES as Readonly<
    Record<Role, readonly Role[]>
>;

/**
 * The roles a caller has with the assigned `roles`: these and every role they
 * include. Names that are no EUDIPLO role, such as Keycloak's
 * `default-roles-<realm>`, are kept as they are.
 */
export function effectiveRoles(roles: readonly string[]): string[] {
    return expandRoles(roles);
}

/**
 * Whether a role name is an EUDIPLO role, unlike for example a Keycloak realm
 * role such as `default-roles-<realm>`.
 */
export function isRole(name: unknown): name is Role {
    return allRoles.includes(name as Role);
}
