import Joi from "joi";

/**
 * Validation schema for outbound webhook configuration
 */
export const WEBHOOK_VALIDATION_SCHEMA = Joi.object({
    OUTBOUND_URL_ALLOW_HTTP: Joi.boolean()
        .default(false)
        .description(
            "Allow HTTP (non-TLS) for outbound calls (webhooks, attribute providers, issuer and schema metadata imports, trust lists, status lists, federation entities, external authorization servers and the upstream provider of a chained authorization server). CRLs may always use HTTP. Enable it for local development against HTTP endpoints.",
        )
        .meta({ group: "webhook", order: 10 }),
    OUTBOUND_URL_ALLOW_PRIVATE_NETWORK: Joi.boolean()
        .default(false)
        .description(
            "Allow outbound calls (webhooks, attribute providers, metadata imports, trust lists, status lists, federation entities, CRLs, external authorization servers and the upstream provider of a chained authorization server) to non-public addresses: private, loopback, link-local, carrier-grade NAT, reserved and the other ranges listed in the security model, e.g. for services inside the same cluster or for local development. The address actually connected to is checked as well (DNS rebinding protection). EUDIPLO's own PUBLIC_URL and INTERNAL_URL are always reachable for trust lists, status lists, federation entity configurations and authorization server keys.",
        )
        .meta({ group: "webhook", order: 20 }),
    OUTBOUND_URL_ALLOWED_HOSTS: Joi.string()
        .allow("")
        .optional()
        .description(
            "Comma-separated hostname allowlist for outbound calls (webhooks, attribute providers, metadata imports, trust lists, status lists, federation entities, CRLs, external and upstream authorization servers; supports exact host and subdomains). When set, other hosts are rejected. Listed hosts still need HTTPS and public addresses unless OUTBOUND_URL_ALLOW_HTTP or OUTBOUND_URL_ALLOW_PRIVATE_NETWORK is set.",
        )
        .meta({ group: "webhook", order: 30 }),
});
