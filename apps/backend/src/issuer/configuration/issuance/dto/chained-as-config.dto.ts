import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

export const UpstreamOidcConfigSchema = z
    .object({
        issuer: z.string(),
        clientId: z.string(),
        clientSecret: z.string().optional(),
        scopes: z.array(z.string()).optional(),
    })
    .strict();

export const ChainedAsTokenConfigSchema = z
    .object({
        lifetimeSeconds: z.number().min(60).optional(),
        signingKeyId: z.string().optional(),
        refreshTokenEnabled: z.boolean().optional(),
        refreshTokenExpiresInSeconds: z.number().min(60).optional(),
    })
    .strict();

const WalletProviderTrustListRefSchema = z
    .object({
        url: z.string(),
        verifierKey: z.record(z.string(), z.unknown()).optional(),
        verifierX509Der: z.string().optional(),
    })
    .strict();

const ChainedAsConfigSchema = z
    .object({
        enabled: z.boolean(),
        upstream: UpstreamOidcConfigSchema.optional(),
        token: ChainedAsTokenConfigSchema.optional(),
        requireDPoP: z.boolean().optional(),
        walletAttestationRequired: z.boolean().optional(),
        walletProviderTrustLists: z
            .array(WalletProviderTrustListRefSchema)
            .optional(),
    })
    .strict();

/**
 * Configuration for the upstream OIDC provider (e.g., Keycloak).
 * EUDIPLO will delegate user authentication to this provider.
 */
export class UpstreamOidcConfig extends createZodDto(UpstreamOidcConfigSchema) {
    /**
     * The OIDC issuer URL of the upstream provider.
     * @example "https://auth.example.com/realms/myrealm"
     */
    @ApiProperty({
        description: "The OIDC issuer URL of the upstream provider",
        example: "https://auth.example.com/realms/myrealm",
    })
    issuer!: string;

    /**
     * The client ID registered with the upstream provider for EUDIPLO.
     */
    @ApiProperty({
        description: "The client ID registered with the upstream provider",
        example: "eudiplo-chained-as",
    })
    clientId!: string;

    /**
     * The client secret for confidential clients.
     * Optional for public clients using PKCE only.
     */
    @ApiPropertyOptional({
        description: "The client secret for confidential clients",
    })
    clientSecret?: string;

    /**
     * The scopes to request from the upstream provider.
     * @default ["openid", "profile"]
     */
    @ApiPropertyOptional({
        description: "Scopes to request from the upstream provider",
        default: ["openid", "profile"],
    })
    scopes?: string[];
}

/**
 * Configuration for the tokens issued by EUDIPLO in chained AS mode.
 */
export class ChainedAsTokenConfig extends createZodDto(
    ChainedAsTokenConfigSchema,
) {
    /**
     * The lifetime of access tokens in seconds.
     * @default 3600 (1 hour)
     */
    @ApiPropertyOptional({
        description: "Access token lifetime in seconds",
        default: 3600,
    })
    lifetimeSeconds?: number;

    /**
     * The key ID to use for signing tokens.
     * Must reference a key configured in the crypto service.
     */
    @ApiPropertyOptional({
        description: "Key ID for token signing",
    })
    signingKeyId?: string;

    /**
     * Whether to issue refresh tokens.
     * @default true
     */
    @ApiPropertyOptional({
        description: "Whether refresh tokens should be issued",
        default: true,
    })
    refreshTokenEnabled?: boolean;

    /**
     * Refresh token lifetime in seconds.
     * @default 2592000 (30 days)
     */
    @ApiPropertyOptional({
        description: "Refresh token lifetime in seconds",
        default: 2592000,
    })
    refreshTokenExpiresInSeconds?: number;
}

/**
 * Configuration for enabling "Chained Authorization Server" mode.
 *
 * In this mode, EUDIPLO acts as the Authorization Server for wallets,
 * but delegates user authentication to an upstream OIDC provider (e.g., Keycloak).
 *
 * Benefits:
 * - No modifications required to the upstream OIDC provider
 * - EUDIPLO can include `issuer_state` in access tokens for session correlation
 * - EUDIPLO handles wallet attestation and OID4VCI-specific requirements
 * - DPoP binding is managed by EUDIPLO
 *
 * Flow:
 * 1. Wallet receives credential offer with `authorization_server = EUDIPLO`
 * 2. Wallet calls EUDIPLO PAR/authorize endpoints
 * 3. EUDIPLO redirects user to upstream OIDC provider for login
 * 4. User authenticates with upstream provider
 * 5. Upstream provider redirects back to EUDIPLO callback
 * 6. EUDIPLO exchanges upstream code for tokens, extracts user identity
 * 7. EUDIPLO issues its own access token with `issuer_state`, DPoP binding, etc.
 * 8. Wallet uses EUDIPLO-issued token for credential requests
 */
export class ChainedAsConfig extends createZodDto(ChainedAsConfigSchema) {
    /**
     * Whether chained AS mode is enabled.
     * When enabled, EUDIPLO acts as the AS and delegates to upstream for authentication.
     */
    @ApiProperty({
        description: "Enable chained AS mode",
        default: false,
    })
    enabled!: boolean;

    /**
     * Configuration for the upstream OIDC provider.
     * Required when enabled is true.
     */
    @ApiPropertyOptional({
        description: "Upstream OIDC provider configuration",
        type: () => UpstreamOidcConfig,
    })
    upstream?: UpstreamOidcConfig;

    /**
     * Configuration for tokens issued by EUDIPLO.
     */
    @ApiPropertyOptional({
        description: "Token configuration",
        type: () => ChainedAsTokenConfig,
    })
    token?: ChainedAsTokenConfig;

    /**
     * Whether to require DPoP for token requests.
     * When true, wallets must provide DPoP proofs.
     * @default true
     */
    @ApiPropertyOptional({
        description: "Require DPoP binding for tokens",
        default: true,
    })
    requireDPoP?: boolean;

    @ApiPropertyOptional({
        description:
            "Require wallet attestation for this authorization server. Omit to inherit the issuance default.",
    })
    walletAttestationRequired?: boolean;

    @ApiPropertyOptional({
        description:
            "Wallet authentication trust lists for this authorization server. Omit to inherit shared issuance trust; an empty array rejects presented attestations.",
        type: "array",
        items: { type: "object" },
    })
    walletProviderTrustLists?: Array<{
        url: string;
        verifierKey?: Record<string, unknown>;
        verifierX509Der?: string;
    }>;
}
