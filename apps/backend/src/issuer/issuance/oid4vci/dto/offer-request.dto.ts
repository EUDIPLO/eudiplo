import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import type { SessionOfferRequest } from "../../../../session/domain/session-data.js";
import {
    ResponseType,
    type ResponseTypeValue,
} from "../../../../verifier/oid4vp/dto/presentation-request.dto.js";
import {
    WebhookConfig,
    WebhookConfigSchema,
} from "../../../../webhook/webhook.dto.js";

export const FlowType = {
    AUTH_CODE: "authorization_code",
    PRE_AUTH_CODE: "pre_authorized_code",
} as const;

export type FlowType = (typeof FlowType)[keyof typeof FlowType];

/**
 * Inline claims source - claims provided directly in the request.
 */
class InlineClaimsSource {
    type!: "inline";

    claims!: Record<string, any>;
}

const InlineClaimsSourceSchema = z
    .object({
        type: z.literal("inline"),
        claims: z.record(z.string(), z.unknown()),
    })
    .strict();

const AttributeProviderClaimsSourceSchema = z
    .object({
        type: z.literal("attributeProvider"),
        attributeProviderId: z.string(),
    })
    .strict();

const WebhookClaimsSourceSchema = z
    .object({
        type: z.literal("webhook"),
        webhook: WebhookConfigSchema,
    })
    .strict();

const ClaimsSourceSchema = z.union([
    InlineClaimsSourceSchema,
    AttributeProviderClaimsSourceSchema,
    WebhookClaimsSourceSchema,
]);

const OfferRequestSchema = z
    .object({
        response_type: z.union([
            z.literal(ResponseType.URI),
            z.literal(ResponseType.DC_API),
            z.literal(ResponseType.ISO_18013_7),
        ]),
        flow: z.union([
            z.literal(FlowType.AUTH_CODE),
            z.literal(FlowType.PRE_AUTH_CODE),
        ]),
        tx_code: z.string().optional(),
        tx_code_description: z.string().optional(),
        credentialConfigurationIds: z.array(z.string()),
        authorization_server: z.string().optional(),
        credentialClaims: z.record(z.string(), ClaimsSourceSchema).optional(),
        webhookEndpointId: z.string().optional(),
        offerLifetimeSeconds: z.coerce.number().int().min(1).optional(),
    })
    .strict()
    .superRefine((data, ctx) => {
        if (!data.credentialClaims) {
            return;
        }

        const allowed = new Set(data.credentialConfigurationIds);
        const invalidKeys = Object.keys(data.credentialClaims).filter(
            (key) => !allowed.has(key),
        );

        if (invalidKeys.length > 0) {
            ctx.addIssue({
                code: "custom",
                path: ["credentialClaims"],
                message: `credentialClaims contains keys [${invalidKeys.join(", ")}] that are not in credentialConfigurationIds [${data.credentialConfigurationIds.join(", ")}]`,
            });
        }
    });

interface OfferRequestData {
    response_type: ResponseTypeValue;
    flow: FlowType;
    tx_code?: string;
    tx_code_description?: string;
    credentialConfigurationIds: string[];
    authorization_server?: string;
    credentialClaims?: Record<string, ClaimsSource>;
    webhookEndpointId?: string;
    offerLifetimeSeconds?: number;
}

type OfferRequestConstructor = new () => OfferRequestData;

const OfferRequestBase: OfferRequestConstructor = createZodDto(
    OfferRequestSchema,
) as OfferRequestConstructor;

class AttributeProviderClaimsSource {
    type!: "attributeProvider";

    attributeProviderId!: string;
}

class WebhookClaimsSource {
    type!: "webhook";

    webhook!: WebhookConfig;
}

/**
 * Union type for all claims source types.
 */
export type ClaimsSource =
    | InlineClaimsSource
    | AttributeProviderClaimsSource
    | WebhookClaimsSource;

export class OfferRequestDto
    extends OfferRequestBase
    implements SessionOfferRequest
{
    @ApiProperty({
        examples: [
            {
                value: "qrcode",
            },
        ],
        description: "The type of response expected for the offer request.",
    })
    response_type!: ResponseTypeValue;

    /**
     * The flow type for the offer request.
     */
    flow!: FlowType;

    /**
     * Transaction code for pre-authorized code flow.
     */
    tx_code?: string;

    /**
     * Description for the transaction code (e.g., "Please enter the PIN sent to your email").
     */
    tx_code_description?: string;

    /**
     * List of credential configuration ids to be included in the offer.
     */
    credentialConfigurationIds!: string[];

    /**
     * Optional authorization server id to be used for this issuance flow.
     */
    @ApiPropertyOptional({
        description:
            "Authorization server id from issuer configuration. If omitted, the first enabled server is used.",
        example: "issuer-built-in",
    })
    authorization_server?: string;

    /**
     * Credential claims configuration per credential.
     * Each credential can have claims provided inline or fetched via webhook.
     * Keys must be a subset of credentialConfigurationIds.
     */
    @ApiProperty({
        description:
            "Credential claims configuration per credential. Keys must match credentialConfigurationIds.",
        type: "object",
        additionalProperties: {
            oneOf: [
                {
                    type: "object",
                    properties: {
                        type: { type: "string", enum: ["inline"] },
                        claims: {
                            type: "object",
                            additionalProperties: true,
                        },
                    },
                    required: ["type", "claims"],
                },
                {
                    type: "object",
                    properties: {
                        type: {
                            type: "string",
                            enum: ["attributeProvider"],
                        },
                        attributeProviderId: { type: "string" },
                    },
                    required: ["type", "attributeProviderId"],
                },
                {
                    type: "object",
                    properties: {
                        type: {
                            type: "string",
                            enum: ["webhook"],
                        },
                        webhook: {
                            type: "object",
                            properties: {
                                url: { type: "string" },
                                auth: { type: "object" },
                            },
                            required: ["url"],
                        },
                    },
                    required: ["type", "webhook"],
                },
            ],
        },
        example: {
            citizen: {
                type: "inline",
                claims: { given_name: "John", family_name: "Doe" },
            },
        },
    })
    credentialClaims?: Record<string, ClaimsSource>;

    /**
     * ID of the webhook endpoint to notify about the status of the issuance process.
     */
    webhookEndpointId?: string;

    /**
     * Lifetime of this offer in seconds, overriding `offerLifetimeSeconds` of
     * the issuance configuration.
     */
    @ApiPropertyOptional({
        description:
            "Lifetime of this offer in seconds. Overrides offerLifetimeSeconds of the issuance configuration. Without both, the offer does not expire.",
        minimum: 1,
        example: 600,
    })
    offerLifetimeSeconds?: number;
}

export class OfferResponse {
    uri!: string;
    /** URI for cross-device flows (no redirect after completion) */
    crossDeviceUri?: string;
    session!: string;
}
