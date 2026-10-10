/**
 * Enumeration of all roles available in the system. The member comments are
 * the role descriptions of the generated docs (apps/docs/scripts/generate-roles-docs.ts).
 */
export enum Role {
    // to manage verifier resources: presentation configurations, trust lists, key chains and webhook endpoints
    Presentations = "presentation:manage",
    // to create presentation requests, read presentation configurations and read or delete presentation sessions
    PresentationRequest = "presentation:request",
    // to manage issuer resources: credential and issuance configurations, attribute providers, status lists, key chains and webhook endpoints, and to publish schema metadata at the registrar
    Issuances = "issuance:manage",
    // to create credential offers, complete or fail deferred issuance, revoke or suspend credentials, and read or delete issuance sessions
    IssuanceOffer = "issuance:offer",
    // to manage the tenant's API clients and read its audit log
    Clients = "clients:manage",
    // to manage the tenant's human users
    Users = "users:manage",
    // platform operator role, needs no tenant: to create, change and delete any tenant, rotate client secrets, and use a tenant's configuration bundles, key export and KMS provider settings
    Tenants = "tenants:manage",
    // to manage the current tenant's full configuration: configuration bundles, key export and KMS provider settings
    TenantAdmin = "tenant:admin",
    // to manage the registrar configuration, enroll access certificates, and list, update, deprecate and delete schema metadata at the registrar
    Registrar = "registrar:manage",
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
];
