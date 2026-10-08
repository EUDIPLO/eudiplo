import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import {
    ChainedAsTokenConfig,
    ChainedAsTokenConfigSchema,
    UpstreamOidcConfig,
    UpstreamOidcConfigSchema,
} from "./chained-as-config.dto.js";

export type AuthorizationServerType =
    | "external"
    | "oid4vp"
    | "chained"
    | "built-in";

const WalletProviderTrustListRefSchema = z
    .object({
        trustListId: z.string().trim().min(1).optional(),
        url: z.url().optional(),
        verifierKey: z.record(z.string(), z.unknown()).optional(),
        verifierKeyPem: z.string().optional(),
        verifierX509Der: z.string().optional(),
    })
    .strict()
    .refine(
        (ref) =>
            !!ref.trustListId ||
            (!!ref.url &&
                (!!ref.verifierKey ||
                    !!ref.verifierKeyPem ||
                    !!ref.verifierX509Der)),
        {
            message:
                "Provide a managed trustListId or a URL with verifier material",
        },
    );

const WalletAttestationAuthorizationServerConfigSchema = {
    walletAttestationRequired: z.boolean().optional(),
    walletProviderTrustLists: z
        .array(WalletProviderTrustListRefSchema)
        .optional(),
};

class WalletProviderTrustListRefDto {
    @ApiPropertyOptional({
        description:
            "Managed trust-list ID in this tenant; resolves URL and signing certificate automatically.",
    })
    trustListId?: string;

    @ApiPropertyOptional({ format: "uri" })
    url?: string;

    @ApiPropertyOptional({
        type: "object",
        additionalProperties: true,
        description: "JWK used to verify the trust-list JWT signature.",
    })
    verifierKey?: Record<string, unknown>;

    @ApiPropertyOptional({
        type: "string",
        description:
            "PEM-encoded public key (SPKI, -----BEGIN PUBLIC KEY-----) used to verify the trust-list JWT signature.",
    })
    verifierKeyPem?: string;

    @ApiPropertyOptional({
        type: "string",
        description:
            "Base64 DER-encoded X.509 certificate used to verify the trust-list JWT signature.",
    })
    verifierX509Der?: string;
}

const ManagedAuthorizationServerConfigSchema = z
    .object({
        type: z.enum(["external", "oid4vp", "chained", "built-in"]),
        id: z.string(),
        label: z.string().optional(),
        enabled: z.boolean().optional(),
    })
    .strict();

const ExternalAuthorizationServerConfigSchema = z
    .object({
        type: z.literal("external"),
        id: z.string(),
        issuer: z.string(),
        sessionBinding: z
            .object({
                method: z.literal("access_token_claim"),
                claim: z.string().min(1),
            })
            .optional(),
        label: z.string().optional(),
        enabled: z.boolean().optional(),
    })
    .strict();

const Oid4VpAuthorizationServerConfigSchema = z
    .object({
        type: z.literal("oid4vp"),
        id: z.string(),
        presentationConfigId: z.string(),
        immediateWalletRedirect: z.boolean().optional(),
        token: ChainedAsTokenConfigSchema.optional(),
        requireDPoP: z.boolean().optional(),
        ...WalletAttestationAuthorizationServerConfigSchema,
        label: z.string().optional(),
        enabled: z.boolean().optional(),
    })
    .strict();

const ChainedAuthorizationServerConfigSchema = z
    .object({
        type: z.literal("chained"),
        id: z.string(),
        upstream: UpstreamOidcConfigSchema,
        token: ChainedAsTokenConfigSchema.optional(),
        requireDPoP: z.boolean().optional(),
        ...WalletAttestationAuthorizationServerConfigSchema,
        label: z.string().optional(),
        enabled: z.boolean().optional(),
    })
    .strict();

const BuiltInAuthorizationServerConfigSchema = z
    .object({
        type: z.literal("built-in"),
        id: z.string(),
        token: ChainedAsTokenConfigSchema.optional(),
        requireDPoP: z.boolean().optional(),
        ...WalletAttestationAuthorizationServerConfigSchema,
        label: z.string().optional(),
        enabled: z.boolean().optional(),
    })
    .strict();

export class ManagedAuthorizationServerConfig extends createZodDto(
    ManagedAuthorizationServerConfigSchema,
) {
    @ApiProperty({
        description: "Authorization server implementation type",
        enum: ["external", "oid4vp", "chained", "built-in"],
        example: "external",
    })
    type!: AuthorizationServerType;

    @ApiProperty({
        description: "Unique identifier for this authorization server",
        example: "pid-auth",
    })
    id!: string;

    @ApiPropertyOptional({
        description: "Human-friendly label for the UI",
        example: "PID Authorization Server",
    })
    label?: string;

    @ApiPropertyOptional({
        description: "Whether this managed authorization server is enabled",
        default: true,
    })
    enabled?: boolean;
}

export class ExternalAuthorizationServerConfig extends createZodDto(
    ExternalAuthorizationServerConfigSchema,
) {
    @ApiProperty({
        description: "Authorization server implementation type",
        enum: ["external"],
        example: "external",
    })
    declare type: "external";

    @ApiProperty({
        description: "Unique identifier for this authorization server",
        example: "external-auth",
    })
    declare id: string;

    @ApiProperty({
        description: "Issuer URL for external authorization servers",
        example: "https://auth.example.com",
    })
    declare issuer: string;

    @ApiPropertyOptional({
        description:
            "How to bind an external access token back to an existing issuance session",
        example: {
            method: "access_token_claim",
            claim: "issuer_state",
        },
    })
    declare sessionBinding?: {
        method: "access_token_claim";
        claim: string;
    };

    declare label?: string;

    declare enabled?: boolean;
}

export class Oid4VpAuthorizationServerConfig extends createZodDto(
    Oid4VpAuthorizationServerConfigSchema,
) {
    @ApiProperty({
        description: "Authorization server implementation type",
        enum: ["oid4vp"],
        example: "oid4vp",
    })
    declare type: "oid4vp";

    @ApiProperty({
        description: "Stable identifier used in the AS URL path",
        example: "pid-auth",
    })
    declare id: string;

    @ApiProperty({
        description: "Presentation configuration ID to use for OID4VP",
        example: "playground-pid",
    })
    declare presentationConfigId: string;

    @ApiPropertyOptional({
        description:
            "Immediately redirect the browser into the wallet OID4VP request",
        default: true,
    })
    declare immediateWalletRedirect?: boolean;

    @ApiPropertyOptional({
        description: "Token configuration for this authorization server",
        type: () => ChainedAsTokenConfig,
    })
    declare token?: ChainedAsTokenConfig;

    @ApiPropertyOptional({
        description:
            "Require DPoP for token requests issued by this authorization server",
        default: false,
    })
    declare requireDPoP?: boolean;

    @ApiPropertyOptional({
        description:
            "Require wallet attestation for requests to this authorization server. Omit to inherit the issuance default.",
    })
    declare walletAttestationRequired?: boolean;

    @ApiPropertyOptional({
        description:
            "Wallet authentication trust lists for this authorization server. Omit to inherit shared issuance trust; an empty array rejects presented attestations.",
        type: [WalletProviderTrustListRefDto],
    })
    declare walletProviderTrustLists?: WalletProviderTrustListRefDto[];

    declare label?: string;

    declare enabled?: boolean;
}

export class ChainedAuthorizationServerConfig extends createZodDto(
    ChainedAuthorizationServerConfigSchema,
) {
    @ApiProperty({
        description: "Authorization server implementation type",
        enum: ["chained"],
        example: "chained",
    })
    declare type: "chained";

    @ApiProperty({
        description: "Unique identifier for this authorization server",
        example: "chained-auth",
    })
    declare id: string;

    @ApiProperty({
        description: "Upstream OIDC provider configuration for chained mode",
        type: () => UpstreamOidcConfig,
    })
    declare upstream: UpstreamOidcConfig;

    @ApiPropertyOptional({
        description: "Token configuration for this authorization server",
        type: () => ChainedAsTokenConfig,
    })
    declare token?: ChainedAsTokenConfig;

    @ApiPropertyOptional({
        description:
            "Require DPoP for token requests issued by this authorization server",
        default: false,
    })
    declare requireDPoP?: boolean;

    @ApiPropertyOptional({
        description:
            "Require wallet attestation for requests to this authorization server. Omit to inherit the issuance default.",
    })
    declare walletAttestationRequired?: boolean;

    @ApiPropertyOptional({
        description:
            "Wallet authentication trust lists for this authorization server. Omit to inherit shared issuance trust; an empty array rejects presented attestations.",
        type: [WalletProviderTrustListRefDto],
    })
    declare walletProviderTrustLists?: WalletProviderTrustListRefDto[];

    declare label?: string;

    declare enabled?: boolean;
}

export class BuiltInAuthorizationServerConfig extends createZodDto(
    BuiltInAuthorizationServerConfigSchema,
) {
    @ApiProperty({
        description: "Authorization server implementation type",
        enum: ["built-in"],
        example: "built-in",
    })
    declare type: "built-in";

    @ApiProperty({
        description: "Unique identifier for this authorization server",
        example: "issuer-built-in",
    })
    declare id: string;

    @ApiPropertyOptional({
        description: "Token configuration for this authorization server",
        type: () => ChainedAsTokenConfig,
    })
    declare token?: ChainedAsTokenConfig;

    @ApiPropertyOptional({
        description:
            "Require DPoP for token requests issued by this authorization server",
        default: false,
    })
    declare requireDPoP?: boolean;

    @ApiPropertyOptional({
        description:
            "Require wallet attestation for requests to this authorization server. Omit to inherit the issuance default.",
    })
    declare walletAttestationRequired?: boolean;

    @ApiPropertyOptional({
        description:
            "Wallet authentication trust lists for this authorization server. Omit to inherit shared issuance trust; an empty array rejects presented attestations.",
        type: [WalletProviderTrustListRefDto],
    })
    declare walletProviderTrustLists?: WalletProviderTrustListRefDto[];

    declare label?: string;

    declare enabled?: boolean;
}
