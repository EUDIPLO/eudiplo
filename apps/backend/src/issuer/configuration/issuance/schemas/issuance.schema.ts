import { z } from "zod";
import { REMOVED_CHAINED_VP_MESSAGE } from "../domain/removed-authorization-servers.js";

const ChainedAsTokenConfigSchema = z
    .object({
        lifetimeSeconds: z.coerce
            .number()
            .min(60)
            .optional()
            .describe("Access token lifetime in seconds."),
        signingKeyId: z
            .string()
            .min(1)
            .optional()
            .describe("Optional key chain id used to sign issued tokens."),
        refreshTokenEnabled: z
            .boolean()
            .optional()
            .describe("Enable issuing refresh tokens."),
        refreshTokenExpiresInSeconds: z.coerce
            .number()
            .min(60)
            .optional()
            .describe("Refresh token lifetime in seconds."),
    })
    .describe("Token issuance settings for authorization servers.")
    .strict();

const UpstreamOidcConfigSchema = z
    .object({
        issuer: z.url().describe("Upstream OIDC issuer URL."),
        clientId: z
            .string()
            .min(1)
            .describe("Client id for upstream OIDC authentication."),
        clientSecret: z
            .string()
            .min(1)
            .optional()
            .describe(
                "Optional client secret for upstream OIDC authentication.",
            ),
        scopes: z
            .array(z.string().min(1))
            .optional()
            .describe("Optional scopes requested from the upstream issuer."),
    })
    .describe("OIDC upstream settings for chained authorization server mode.")
    .strict();

const WalletProviderTrustListRefSchema = z
    .object({
        trustListId: z.string().trim().min(1).optional(),
        url: z
            .url()
            .optional()
            .describe("URL of the wallet provider trust list."),
        verifierKey: z
            .record(z.string(), z.unknown())
            .optional()
            .describe(
                "Optional verifier key material used for trust list verification.",
            ),
        verifierX509Der: z
            .string()
            .optional()
            .describe("Optional verifier certificate in DER/base64 form."),
    })
    .describe("Wallet provider trust list reference.")
    .strict()
    .refine(
        (ref) =>
            !!ref.trustListId ||
            (!!ref.url && (!!ref.verifierKey || !!ref.verifierX509Der)),
        {
            message:
                "Provide a managed trustListId or a URL with verifier material",
        },
    );

const WalletAttestationAuthorizationServerSchema = {
    walletAttestationRequired: z
        .boolean()
        .optional()
        .describe("Require wallet attestation for this authorization server."),
    walletProviderTrustLists: z
        .array(WalletProviderTrustListRefSchema)
        .optional()
        .describe(
            "Optional wallet provider trust list references for this authorization server.",
        ),
};

const ExternalAuthorizationServerConfigSchema = z
    .object({
        type: z
            .literal("external")
            .describe("Use an externally managed authorization server."),
        id: z.string().min(1).describe("Authorization server identifier."),
        issuer: z
            .url()
            .describe("Issuer URL for the external authorization server."),
        sessionBinding: z
            .object({
                method: z
                    .literal("access_token_claim")
                    .describe(
                        "Read the correlation value from a configured access-token claim.",
                    ),
                claim: z
                    .string()
                    .min(1)
                    .describe(
                        "Claim name that contains the issuance-session correlation value.",
                    ),
            })
            .optional()
            .describe(
                "Explicit mapping from an external access-token claim to an existing issuance session.",
            ),
        label: z
            .string()
            .optional()
            .describe("Optional display label for UI selection."),
        enabled: z
            .boolean()
            .optional()
            .describe("Whether this authorization server entry is enabled."),
    })
    .describe("External authorization server configuration.")
    .strict();

const Oid4VpAuthorizationServerConfigSchema = z
    .object({
        type: z
            .literal("oid4vp")
            .describe("Use OID4VP-based authorization server chaining."),
        id: z.string().min(1).describe("Authorization server identifier."),
        presentationConfigId: z
            .string()
            .min(1)
            .describe(
                "Presentation configuration id used during authorization.",
            ),
        immediateWalletRedirect: z
            .boolean()
            .optional()
            .describe(
                "Redirect wallets immediately after authorization response creation.",
            ),
        token: ChainedAsTokenConfigSchema.optional().describe(
            "Optional token issuance settings.",
        ),
        requireDPoP: z
            .boolean()
            .optional()
            .describe("Require DPoP proofs for token/credential requests."),
        ...WalletAttestationAuthorizationServerSchema,
        label: z
            .string()
            .optional()
            .describe("Optional display label for UI selection."),
        enabled: z
            .boolean()
            .optional()
            .describe("Whether this authorization server entry is enabled."),
    })
    .describe("OID4VP authorization server configuration.")
    .strict();

const ChainedAuthorizationServerConfigSchema = z
    .object(
        {
            type: z
                .literal("chained")
                .describe("Use upstream OIDC as authorization source."),
            id: z.string().min(1).describe("Authorization server identifier."),
            upstream: UpstreamOidcConfigSchema.describe(
                "Upstream OIDC connection settings.",
            ),
            token: ChainedAsTokenConfigSchema.optional().describe(
                "Optional token issuance settings.",
            ),
            requireDPoP: z
                .boolean()
                .optional()
                .describe("Require DPoP proofs for token/credential requests."),
            ...WalletAttestationAuthorizationServerSchema,
            label: z
                .string()
                .optional()
                .describe("Optional display label for UI selection."),
            enabled: z
                .boolean()
                .optional()
                .describe(
                    "Whether this authorization server entry is enabled.",
                ),
        },
        {
            // Point configurations of the removed `vp` option to `oid4vp`.
            error: (issue) =>
                issue.code === "unrecognized_keys" && issue.keys.includes("vp")
                    ? REMOVED_CHAINED_VP_MESSAGE
                    : undefined,
        },
    )
    .describe("Chained authorization server configuration.")
    .strict();

const BuiltInAuthorizationServerConfigSchema = z
    .object({
        type: z
            .literal("built-in")
            .describe("Use EUDIPLO built-in authorization server."),
        id: z.string().min(1).describe("Authorization server identifier."),
        token: ChainedAsTokenConfigSchema.optional().describe(
            "Optional token issuance settings.",
        ),
        requireDPoP: z
            .boolean()
            .optional()
            .describe("Require DPoP proofs for token/credential requests."),
        ...WalletAttestationAuthorizationServerSchema,
        label: z
            .string()
            .optional()
            .describe("Optional display label for UI selection."),
        enabled: z
            .boolean()
            .optional()
            .describe("Whether this authorization server entry is enabled."),
    })
    .describe("Built-in authorization server configuration.")
    .strict();

const ManagedAuthorizationServerSchema = z
    .discriminatedUnion("type", [
        ExternalAuthorizationServerConfigSchema,
        Oid4VpAuthorizationServerConfigSchema,
        ChainedAuthorizationServerConfigSchema,
        BuiltInAuthorizationServerConfigSchema,
    ])
    .describe("Supported authorization server configurations.");

const DisplayLogoSchema = z
    .object({
        uri: z.string().min(1).describe("Logo URI."),
        alt_text: z
            .string()
            .optional()
            .describe("Optional localized alternative text."),
    })
    .describe("Display logo metadata.")
    .catchall(z.unknown());

const DisplayInfoSchema = z
    .object({
        name: z.string().optional().describe("Issuer display name."),
        locale: z
            .string()
            .optional()
            .describe("Locale tag for this display entry."),
        logo: DisplayLogoSchema.optional().describe(
            "Optional issuer logo metadata.",
        ),
    })
    .describe("Localized issuer display metadata.")
    .catchall(z.unknown());

const FederationTrustAnchorConfigSchema = z
    .object({
        entityId: z
            .string()
            .min(1)
            .describe("Federation trust anchor entity id."),
        entityConfigurationUri: z
            .url()
            .describe("Entity configuration URI for the trust anchor."),
    })
    .describe("Trust anchor reference for OpenID Federation.")
    .strict();

const UNSUPPORTED_FEDERATION_ROLE =
    "Only the federation role 'leaf' is supported: EUDIPLO does not act as a trust anchor or intermediate";
const UNSUPPORTED_FEDERATION_SIGNING_POLICY =
    "enforceSigningPolicy cannot be disabled: federation trust checks are always enforced";

/**
 * Federation options the schema accepts but EUDIPLO cannot honor: a role
 * other than `leaf` (no entity configuration is published) and a disabled
 * signing policy (federation checks are always enforced).
 *
 * @returns the reason, or `undefined` when the options are supported.
 */
export function unsupportedFederationOption(
    federation:
        | { role?: string | null; enforceSigningPolicy?: boolean | null }
        | null
        | undefined,
): string | undefined {
    if (federation?.role != null && federation.role !== "leaf") {
        return UNSUPPORTED_FEDERATION_ROLE;
    }
    if (federation?.enforceSigningPolicy === false) {
        return UNSUPPORTED_FEDERATION_SIGNING_POLICY;
    }
    return undefined;
}

const FederationConfigSchema = z
    .object({
        role: z
            .enum(["trust_anchor", "intermediate", "leaf"])
            .optional()
            .refine((role) => !unsupportedFederationOption({ role }), {
                message: UNSUPPORTED_FEDERATION_ROLE,
            })
            .describe("Federation role for this issuer."),
        mode: z
            .enum(["federation-only", "hybrid"])
            .optional()
            .describe("Federation operation mode."),
        entityId: z
            .string()
            .optional()
            .describe("Optional local federation entity id."),
        enforceSigningPolicy: z
            .boolean()
            .optional()
            .refine(
                (enforceSigningPolicy) =>
                    !unsupportedFederationOption({ enforceSigningPolicy }),
                { message: UNSUPPORTED_FEDERATION_SIGNING_POLICY },
            )
            .describe("Enforce strict signing policy checks."),
        cacheTtlSeconds: z.coerce
            .number()
            .int()
            .min(1)
            .optional()
            .describe("Cache time-to-live for federation metadata in seconds."),
        trustAnchors: z
            .array(FederationTrustAnchorConfigSchema)
            .describe("Federation trust anchors."),
    })
    .describe("OpenID Federation configuration.")
    .strict();

const IssuerRegistrationCertificateConfigSchema = z
    .object({
        enabled: z
            .boolean()
            .optional()
            .describe("Enable issuer registration certificate support."),
        mode: z
            .enum(["import", "generate"])
            .optional()
            .describe("How registration certificate data is provided."),
        jwt: z
            .string()
            .optional()
            .describe(
                "Optional registration certificate JWT when using import mode.",
            ),
        privacyPolicy: z
            .string()
            .optional()
            .describe("Optional privacy policy URI."),
        supportUri: z.string().optional().describe("Optional support URI."),
    })
    .describe("Issuer registration certificate settings.")
    .strict();

export const IssuanceConfigSchema = z
    .object({
        batchSize: z.coerce
            .number()
            .int()
            .min(1)
            .optional()
            .describe("Optional issuance batch size."),
        dPopRequired: z
            .boolean()
            .optional()
            .describe("Require DPoP proofs for issuance endpoints."),
        walletAttestationRequired: z
            .boolean()
            .optional()
            .describe(
                "Default wallet attestation requirement for managed authorization servers.",
            ),
        walletProviderTrustLists: z
            .array(WalletProviderTrustListRefSchema)
            .optional()
            .describe(
                "Shared wallet provider trust lists for key attestations and default authorization server wallet authentication.",
            ),
        signingKeyId: z
            .string()
            .min(1)
            .optional()
            .describe("Default signing key chain id for credential issuance."),
        authorizationServers: z
            .array(ManagedAuthorizationServerSchema)
            .min(1)
            .describe("Configured authorization server entries."),
        federation: FederationConfigSchema.nullable()
            .optional()
            .describe("Optional OpenID Federation settings."),
        registrationCertificate:
            IssuerRegistrationCertificateConfigSchema.nullable()
                .optional()
                .describe("Optional registration certificate settings."),
        display: z
            .array(DisplayInfoSchema)
            .optional()
            .describe("Localized issuer metadata shown to wallets."),
        notificationEndpointEnabled: z
            .boolean()
            .optional()
            .describe(
                "Whether the OID4VCI notification endpoint is exposed for this issuance configuration.",
            ),
        credentialResponseEncryption: z
            .boolean()
            .optional()
            .describe("Enable encrypted credential responses."),
        credentialRequestEncryption: z
            .boolean()
            .optional()
            .describe("Require encrypted credential requests."),
        txCodeMaxAttempts: z.coerce
            .number()
            .int()
            .min(1)
            .nullable()
            .optional()
            .describe(
                "Maximum verification attempts for transaction codes. Null resets to defaults.",
            ),
        offerLifetimeSeconds: z.coerce
            .number()
            .int()
            .min(1)
            .nullable()
            .optional()
            .describe(
                "Default lifetime of credential offers in seconds. Can be overridden per offer request. Null or unset: offers do not expire.",
            ),
    })
    .describe("Issuer issuance configuration.")
    .strict();
