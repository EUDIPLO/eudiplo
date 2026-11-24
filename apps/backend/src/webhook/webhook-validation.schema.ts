import Joi from "joi";

/**
 * Validation schema for outbound webhook configuration
 */
export const WEBHOOK_VALIDATION_SCHEMA = Joi.object({
    OUTBOUND_URL_ALLOW_HTTP: Joi.boolean()
        .default(false)
        .description(
            "Allow HTTP (non-TLS) for outbound calls (webhooks, attribute providers, issuer and schema metadata imports, trust lists, status lists, federation entities and the federation trust engine, the EUDI Hub and the issuing CA of its access certificates, external authorization servers, the upstream provider of a chained authorization server and the KMS providers of a tenant kms.json). CRLs may always use HTTP. Also lets the federation entity ID of a tenant (federation.entityId) be an http URL. Enable it for local development against HTTP endpoints.",
        )
        .meta({ group: "webhook", order: 10 }),
    OUTBOUND_URL_ALLOW_PRIVATE_NETWORK: Joi.boolean()
        .default(false)
        .description(
            "Allow outbound calls (webhooks, attribute providers, metadata imports, trust lists, status lists, federation entities and the federation trust engine, CRLs, the EUDI Hub and the issuing CA of its access certificates, external authorization servers, the upstream provider of a chained authorization server and the KMS providers of a tenant kms.json) to non-public addresses: private, loopback, link-local, carrier-grade NAT, reserved and the other ranges listed in the security model, e.g. for services inside the same cluster or for local development. The address actually connected to is checked as well (DNS rebinding protection). EUDIPLO's own PUBLIC_URL and INTERNAL_URL are always reachable for trust lists, status lists, federation entity configurations and subordinate statements and authorization server keys.",
        )
        .meta({ group: "webhook", order: 20 }),
    OUTBOUND_URL_ALLOWED_HOSTS: Joi.string()
        .allow("")
        .optional()
        .description(
            "Comma-separated hostname allowlist for outbound calls (webhooks, attribute providers, metadata imports, trust lists, status lists, federation entities and the federation trust engine, CRLs, the EUDI Hub and the issuing CA of its access certificates, external and upstream authorization servers, the KMS providers of a tenant kms.json; supports exact host and subdomains). When set, other hosts are rejected. Listed hosts still need HTTPS and public addresses unless OUTBOUND_URL_ALLOW_HTTP or OUTBOUND_URL_ALLOW_PRIVATE_NETWORK is set.",
        )
        .meta({ group: "webhook", order: 30 }),
});
