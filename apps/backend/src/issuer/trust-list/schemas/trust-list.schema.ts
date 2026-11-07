import {
    isTrustListEntityUri,
    TRUST_LIST_COUNTRY_CODES,
    TRUST_LIST_COUNTRY_DESCRIPTION,
    TRUST_LIST_COUNTRY_MESSAGE,
    TRUST_LIST_LANGUAGE_DESCRIPTION,
    TRUST_LIST_LANGUAGE_MESSAGE,
    TRUST_LIST_LANGUAGE_TAG_PATTERN,
    TRUST_LIST_URI_DESCRIPTION,
    TRUST_LIST_URI_MESSAGE,
} from "@eudiplo/config-format/trust-list-entity-info.js";
import { z } from "zod";

const TrustListEntityInfoSchema = z
    .object({
        name: z.string().min(1).describe("Display name of the trusted entity."),
        lang: z
            .string()
            .regex(
                new RegExp(TRUST_LIST_LANGUAGE_TAG_PATTERN),
                TRUST_LIST_LANGUAGE_MESSAGE,
            )
            .optional()
            .describe(TRUST_LIST_LANGUAGE_DESCRIPTION),
        locale: z.string().optional().describe("Optional locale identifier."),
        uri: z
            // abort: a value that is no URL gets one error, not two.
            .url({ abort: true })
            .refine(isTrustListEntityUri, TRUST_LIST_URI_MESSAGE)
            .optional()
            .describe(TRUST_LIST_URI_DESCRIPTION),
        country: z
            .enum(TRUST_LIST_COUNTRY_CODES as [string, ...string[]], {
                error: TRUST_LIST_COUNTRY_MESSAGE,
            })
            .optional()
            .describe(TRUST_LIST_COUNTRY_DESCRIPTION),
        locality: z.string().optional().describe("Optional locality or city."),
        postalCode: z.string().optional().describe("Optional postal code."),
        streetAddress: z
            .string()
            .optional()
            .describe("Optional street address."),
        contactUri: z
            .string()
            .optional()
            .describe("Optional contact URI for the entity."),
    })
    .describe("Human-readable metadata for a trust list entity.")
    .strict();

const InternalTrustListEntitySchema = z
    .object({
        type: z
            .literal("internal")
            .describe(
                "`internal` references key chains of this tenant; `external` carries the certificates directly, as PEM or Base64 DER.",
            ),
        issuerKeyChainId: z
            .string()
            .min(1)
            .describe("Key chain id for issuer certificate material."),
        revocationKeyChainId: z
            .string()
            .min(1)
            .describe(
                "Key chain id for revocation/status list certificate material.",
            ),
        providerType: z
            .enum(["attestation-provider", "wallet-provider"])
            .optional()
            .describe("Provider role; defaults to attestation-provider."),
        info: TrustListEntityInfoSchema.describe("Entity metadata."),
    })
    .describe("Trust list entity referencing internal key chains.")
    .strict();

const ExternalTrustListEntitySchema = z
    .object({
        type: z
            .literal("external")
            .describe(
                "`internal` references key chains of this tenant; `external` carries the certificates directly, as PEM or Base64 DER.",
            ),
        issuerCertPem: z
            .string()
            .min(1)
            .describe("Issuer certificate as PEM or Base64 DER."),
        revocationCertPem: z
            .string()
            .min(1)
            .describe("Revocation/status certificate as PEM or Base64 DER."),
        providerType: z
            .enum(["attestation-provider", "wallet-provider"])
            .optional()
            .describe("Provider role; defaults to attestation-provider."),
        info: TrustListEntityInfoSchema.describe("Entity metadata."),
    })
    .describe("Trust list entity using externally supplied PEM certificates.")
    .strict();

export const TrustListCreateSchema = z
    .object({
        id: z
            .string()
            .min(1)
            .optional()
            .describe(
                "Optional trust list id. If omitted, one may be generated.",
            ),
        description: z
            .string()
            .optional()
            .describe("Optional trust list description."),
        keyChainId: z
            .string()
            .min(1)
            .optional()
            .describe(
                "Optional key chain id used to sign trust list payloads.",
            ),
        entities: z
            .array(
                z.discriminatedUnion("type", [
                    InternalTrustListEntitySchema,
                    ExternalTrustListEntitySchema,
                ]),
            )
            .min(1)
            .describe("One or more entities included in this trust list."),
        data: z
            .record(z.string(), z.unknown())
            .optional()
            .describe("Optional additional custom payload data."),
    })
    .describe("Payload for creating a trust list configuration.")
    .strict();
