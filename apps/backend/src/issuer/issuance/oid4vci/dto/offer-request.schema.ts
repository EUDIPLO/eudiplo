import { z } from "zod";
import { ResponseType } from "../../../../verifier/oid4vp/dto/presentation-request.schema.js";
import { WebhookConfigSchema } from "../../../../webhook/webhook.schema.js";

export const FlowType = {
    AUTH_CODE: "authorization_code",
    PRE_AUTH_CODE: "pre_authorized_code",
} as const;

export type FlowType = (typeof FlowType)[keyof typeof FlowType];

const InlineClaimsSourceSchema = z
    .object({
        type: z.literal("inline").describe("Claims are passed in the request."),
        claims: z
            .record(z.string(), z.unknown())
            .describe(
                "Claim values; validated against the credential configuration's fields when the offer is created.",
            ),
    })
    .strict();

const AttributeProviderClaimsSourceSchema = z
    .object({
        type: z
            .literal("attributeProvider")
            .describe("Claims are fetched from an attribute provider."),
        attributeProviderId: z
            .string()
            .describe("ID of an attribute provider of the tenant."),
    })
    .strict();

const WebhookClaimsSourceSchema = z
    .object({
        type: z
            .literal("webhook")
            .describe(
                "Claims are fetched from a webhook defined for this offer only.",
            ),
        webhook: WebhookConfigSchema.describe(
            "Endpoint called like an attribute provider.",
        ),
    })
    .strict();

const ClaimsSourceSchema = z.union([
    InlineClaimsSourceSchema,
    AttributeProviderClaimsSourceSchema,
    WebhookClaimsSourceSchema,
]);

export const OfferRequestSchema = z
    .object({
        response_type: z
            .union([
                z.literal(ResponseType.URI),
                z.literal(ResponseType.DC_API),
                z.literal(ResponseType.ISO_18013_7),
            ])
            .describe(
                "Required by the schema; issuance offers are always returned as JSON with the offer URI. Use `uri`.",
            ),
        flow: z
            .union([
                z.literal(FlowType.AUTH_CODE),
                z.literal(FlowType.PRE_AUTH_CODE),
            ])
            .describe("OID4VCI grant offered to the wallet."),
        tx_code: z
            .string()
            .optional()
            .describe(
                "Transaction code the user must enter (pre-authorized code flow only).",
            ),
        tx_code_description: z
            .string()
            .optional()
            .describe("Hint shown by the wallet when asking for the tx_code."),
        credentialConfigurationIds: z
            .array(z.string())
            .describe("Credential configurations offered to the wallet."),
        authorization_server: z
            .string()
            .optional()
            .describe(
                "ID of an enabled entry of the issuance configuration's authorizationServers. Defaults to the first enabled entry.",
            ),
        credentialClaims: z
            .record(z.string(), ClaimsSourceSchema)
            .optional()
            .describe(
                "Claim source per credential configuration ID; keys must appear in credentialConfigurationIds. Overrides the configuration's attribute provider and static defaults.",
            ),
        webhookEndpointId: z
            .string()
            .optional()
            .describe(
                "Webhook endpoint that receives the wallet's notification events for this offer.",
            ),
        offerLifetimeSeconds: z.coerce
            .number()
            .int()
            .min(1)
            .optional()
            .describe(
                "Lifetime of this offer in seconds. Overrides offerLifetimeSeconds of the issuance configuration; without both the offer does not expire.",
            ),
        reference: z
            .string()
            .trim()
            .min(1)
            .max(255)
            .optional()
            .describe(
                "Your own reference for this offer, e.g. an order or case id. Stored in plaintext, searchable in the session list, included in webhooks and kept when the session is anonymized. Must not contain personal data.",
            ),
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
