import { z } from "zod";
import { RegistrationCertificateRequestSchema } from "../dto/vp-request.dto.js";

const CredentialIdSchema = z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9_-]+$/, {
        message:
            "Credential id must contain only alphanumeric, underscore (_), or hyphen (-) characters",
    });

const TenantUrlPlaceholderSchema = z
    .string()
    .regex(/^<TENANT_URL>(?:\/.*)?$/, "expected a URL");

const TrustListUrlSchema = z.union([z.url(), TenantUrlPlaceholderSchema]);

const TrustListRefSchema = z
    .object({
        trustListId: z
            .string()
            .optional()
            .describe("Optional trust list id reference."),
        url: TrustListUrlSchema.optional().describe(
            "Optional trust list URL reference.",
        ),
        verifierKey: z
            .record(z.string(), z.unknown())
            .optional()
            .describe("Optional verifier key material."),
        verifierX509Der: z
            .string()
            .optional()
            .describe("Optional verifier certificate in DER/base64 form."),
    })
    .describe("Reference to a trust list used for authority verification.")
    .strict();

const TrustedAuthorityQueryEtsiTlSchema = z
    .object({
        type: z
            .literal("etsi_tl")
            .describe(
                "Trusted authority type discriminator for ETSI trust lists.",
            ),
        values: z
            .array(TrustListRefSchema)
            .describe("Trust list references for ETSI TL verification."),
    })
    .describe("ETSI trusted authority query.")
    .strict();

const TrustedAuthorityQueryOpenIdFederationSchema = z
    .object({
        type: z
            .literal("openid_federation")
            .describe(
                "Trusted authority type discriminator for OpenID Federation.",
            ),
        values: z
            .array(z.string())
            .describe("OpenID Federation authority identifiers."),
    })
    .describe("OpenID Federation trusted authority query.")
    .strict();

const ClaimsQuerySchema = z
    .object({
        id: z.string().optional().describe("Optional claim query id."),
        path: z
            .array(z.union([z.string(), z.number()]))
            .describe("Path to the claim value in presented credentials."),
        values: z
            .array(z.union([z.string(), z.number().int(), z.boolean()]))
            .min(1)
            .optional()
            .describe(
                "Optional allowed values for the claim. A disclosed value must equal one of them in type and value.",
            ),
    })
    .describe("Claim query constraint.")
    .strict();

const MsoMdocClaimsQuerySchema = ClaimsQuerySchema.extend({
    intent_to_retain: z
        .boolean()
        .optional()
        .describe("Whether relying party intends to retain the claim."),
}).strict();

const CredentialQueryBaseSchema = z
    .object({
        id: CredentialIdSchema.describe("Credential query identifier."),
        multiple: z
            .boolean()
            .optional()
            .describe("Allow multiple matching credentials."),
        claim_sets: z
            .array(z.array(z.string()))
            .optional()
            .describe("Optional claim set constraints."),
        trusted_authorities: z
            .array(
                z.discriminatedUnion("type", [
                    TrustedAuthorityQueryEtsiTlSchema,
                    TrustedAuthorityQueryOpenIdFederationSchema,
                ]),
            )
            .optional()
            .describe("Optional trusted authority constraints."),
    })
    .describe("Base credential query structure.")
    .strict();

function validateClaimSets(
    credential: z.infer<typeof CredentialQueryBaseSchema> & {
        claims?: Array<{ id?: string }>;
    },
    ctx: z.RefinementCtx,
) {
    if (!credential.claim_sets || credential.claim_sets.length === 0) {
        return;
    }

    const claimsById = new Map<string, number>();
    for (const [index, claim] of (credential.claims ?? []).entries()) {
        if (typeof claim.id !== "string" || claim.id.trim() === "") {
            continue;
        }

        const previousIndex = claimsById.get(claim.id);
        if (previousIndex !== undefined) {
            ctx.addIssue({
                code: "custom",
                path: ["claims", index, "id"],
                message: `Duplicate claim id '${claim.id}' already used at claims[${previousIndex}]`,
            });
            continue;
        }

        claimsById.set(claim.id, index);
    }

    if (claimsById.size === 0) {
        ctx.addIssue({
            code: "custom",
            path: ["claim_sets"],
            message:
                "claim_sets requires at least one claim with an id in claims",
        });
        return;
    }

    credential.claim_sets.forEach((claimSet, setIndex) => {
        claimSet.forEach((claimId, claimIndex) => {
            if (!claimsById.has(claimId)) {
                ctx.addIssue({
                    code: "custom",
                    path: ["claim_sets", setIndex, claimIndex],
                    message: `claim_sets references unknown claim id '${claimId}' for credential '${credential.id}'`,
                });
            }
        });
    });
}

const CredentialQueryDcSdJwtSchema = CredentialQueryBaseSchema.extend({
    format: z.literal("dc+sd-jwt").describe("Credential format discriminator."),
    meta: z
        .object({
            vct_values: z
                .array(z.string())
                .min(1)
                .describe("Accepted VCT values."),
        })
        .describe("Format-specific metadata for dc+sd-jwt queries.")
        .strict(),
    claims: z
        .array(ClaimsQuerySchema)
        .optional()
        .describe("Optional claim-level constraints."),
})
    .strict()
    .superRefine((credential, ctx) => validateClaimSets(credential, ctx));

const CredentialQueryMsoMdocSchema = CredentialQueryBaseSchema.extend({
    format: z.literal("mso_mdoc").describe("Credential format discriminator."),
    meta: z
        .object({
            doctype_value: z
                .string()
                .min(1)
                .describe("Expected mDoc doctype value."),
        })
        .describe("Format-specific metadata for mso_mdoc queries.")
        .strict(),
    claims: z
        .array(MsoMdocClaimsQuerySchema)
        .optional()
        .describe("Optional mDoc claim-level constraints."),
})
    .strict()
    .superRefine((credential, ctx) => validateClaimSets(credential, ctx));

const CredentialSetQuerySchema = z
    .object({
        options: z
            .array(z.array(z.string()).min(1))
            .min(1)
            .describe("Alternative credential query id combinations."),
        required: z
            .boolean()
            .optional()
            .describe("Whether this credential set is mandatory."),
    })
    .describe("Credential set query constraints.")
    .strict();

export const DCQLSchema = z
    .object({
        credentials: z
            .array(
                z.discriminatedUnion("format", [
                    CredentialQueryDcSdJwtSchema,
                    CredentialQueryMsoMdocSchema,
                ]),
            )
            .min(1)
            .describe("Credential queries requested by the verifier."),
        credential_sets: z
            .array(CredentialSetQuerySchema)
            .optional()
            .describe("Optional higher-level credential set requirements."),
    })
    .describe("Digital Credential Query Language payload.")
    .strict()
    .superRefine((dcql, ctx) => {
        const seen = new Map<string, number>();

        dcql.credentials.forEach((credential, index) => {
            const firstIndex = seen.get(credential.id);
            if (firstIndex !== undefined) {
                ctx.addIssue({
                    code: "custom",
                    path: ["credentials", index, "id"],
                    message: `Duplicate credential id '${credential.id}' already used at credentials[${firstIndex}]`,
                });
                return;
            }

            seen.set(credential.id, index);
        });
    });

export const TransactionDataSchema = z
    .object({
        type: z.string().describe("Transaction data type identifier."),
        credential_ids: z
            .array(z.string())
            .describe("Credential query ids this transaction data applies to."),
        payload: z
            .unknown()
            .optional()
            .describe(
                "Transaction details. Required for TS12 SCA transaction data.",
            ),
    })
    .describe("Transaction data request descriptor.")
    .catchall(z.unknown())
    .superRefine((transactionData, ctx) => {
        if (!transactionData.type.startsWith("urn:eudi:sca:")) {
            return;
        }

        if (!isTs12TransactionDataType(transactionData.type)) {
            ctx.addIssue({
                code: "custom",
                path: ["type"],
                message: "Unsupported TS12 transaction data type.",
            });
        }

        validateTs12TransactionPayload(transactionData, ctx);
    });

function validateTs12TransactionPayload(
    transactionData: Record<string, unknown>,
    ctx: z.RefinementCtx,
): void {
    if (
        !transactionData.payload ||
        typeof transactionData.payload !== "object" ||
        Array.isArray(transactionData.payload)
    ) {
        ctx.addIssue({
            code: "custom",
            path: ["payload"],
            message: "TS12 transaction data requires an object payload.",
        });
        return;
    }

    const payload = transactionData.payload as Record<string, unknown>;
    const requireString = (field: string) => {
        if (typeof payload[field] !== "string" || !payload[field]) {
            ctx.addIssue({
                code: "custom",
                path: ["payload", field],
                message: `TS12 ${transactionData.type} requires payload.${field}.`,
            });
        }
    };

    requireString("transaction_id");

    if (transactionData.type === "urn:eudi:sca:payment:1") {
        validateTs12PaymentPayload(payload, ctx);
    }

    if (transactionData.type === "urn:eudi:sca:login_risk_transaction:1") {
        requireString("action");
    }
}

function validateTs12PaymentPayload(
    payload: Record<string, unknown>,
    ctx: z.RefinementCtx,
): void {
    const payee = payload.payee;
    if (!payee || typeof payee !== "object" || Array.isArray(payee)) {
        ctx.addIssue({
            code: "custom",
            path: ["payload", "payee"],
            message: "TS12 payment requires a payee object.",
        });
    } else {
        const payeeRecord = payee as Record<string, unknown>;
        for (const field of ["name", "id"]) {
            if (typeof payeeRecord[field] !== "string" || !payeeRecord[field]) {
                ctx.addIssue({
                    code: "custom",
                    path: ["payload", "payee", field],
                    message: `TS12 payment requires payee.${field}.`,
                });
            }
        }
    }
    if (!/^[A-Z]{3}$/.test(String(payload.currency ?? ""))) {
        ctx.addIssue({
            code: "custom",
            path: ["payload", "currency"],
            message: "TS12 payment requires a three-letter uppercase currency.",
        });
    }
    if (typeof payload.amount !== "number") {
        ctx.addIssue({
            code: "custom",
            path: ["payload", "amount"],
            message: "TS12 payment requires a numeric amount.",
        });
    }
}

function isTs12TransactionDataType(type: string): boolean {
    return [
        "urn:eudi:sca:payment:1",
        "urn:eudi:sca:login_risk_transaction:1",
        "urn:eudi:sca:account_access:1",
        "urn:eudi:sca:emandate:1",
    ].includes(type);
}

const PresentationAttachmentSchema = z
    .object({
        format: z.string().describe("Attachment format identifier."),
        data: z.unknown().describe("Attachment payload."),
        credential_ids: z
            .array(z.string())
            .optional()
            .describe(
                "Optional credential query ids bound to this attachment.",
            ),
    })
    .describe("Additional presentation attachment.")
    .strict();

const RegistrationCertificateFormPurposeSchema = z
    .object({
        lang: z.string().optional(),
        content: z.string().optional(),
    })
    .describe("Registration certificate purpose entry from the management UI.")
    .strict();

export const PresentationConfigCreateSchema = z
    .object({
        id: z
            .string()
            .min(1)
            .describe("Presentation configuration identifier."),
        description: z
            .string()
            .nullable()
            .optional()
            .describe("Optional presentation configuration description."),
        lifeTime: z.coerce
            .number()
            .int()
            .min(1)
            .optional()
            .describe("Presentation request lifetime in seconds."),
        skewSeconds: z.coerce
            .number()
            .int()
            .min(0)
            .optional()
            .describe("Clock skew tolerance in seconds."),
        statusCheckMode: z
            .enum(["strict", "best_effort", "disabled"])
            .optional()
            .describe("Revocation/status check mode."),
        dcql_query: DCQLSchema.describe(
            "DCQL query defining requested credentials and claims.",
        ),
        transaction_data: z
            .array(TransactionDataSchema)
            .nullable()
            .optional()
            .describe("Optional transaction data descriptors."),
        registration_cert: RegistrationCertificateRequestSchema.nullable()
            .optional()
            .describe("Optional registration certificate request settings."),
        registrationCertImportJwt: z
            .string()
            .nullable()
            .optional()
            .describe("Optional imported registration certificate JWT."),
        registrationCertImportId: z
            .string()
            .nullable()
            .optional()
            .describe("Optional registrar-side registration certificate id."),
        registrationCertBodyPrivacyPolicy: z
            .string()
            .nullable()
            .optional()
            .describe("Optional registration certificate privacy policy URI."),
        registrationCertBodySupportUri: z
            .string()
            .nullable()
            .optional()
            .describe("Optional registration certificate support URI."),
        registrationCertBodyIntermediary: z
            .string()
            .nullable()
            .optional()
            .describe("Optional registration certificate intermediary."),
        registrationCertBodyPurpose: z
            .array(RegistrationCertificateFormPurposeSchema)
            .nullable()
            .optional()
            .describe("Optional registration certificate purpose entries."),
        webhookEndpointId: z
            .string()
            .nullable()
            .optional()
            .describe(
                "Optional webhook endpoint id for presentation callbacks.",
            ),
        attached: z
            .array(PresentationAttachmentSchema)
            .nullable()
            .optional()
            .describe(
                "Optional attachments included with presentation requests.",
            ),
        redirectUri: z
            .string()
            .nullable()
            .optional()
            .describe("Optional redirect URI after presentation completion."),
        accessKeyChainId: z
            .string()
            .nullable()
            .optional()
            .describe(
                "Optional key chain id for access token/auth operations.",
            ),
        readerAuth: z
            .boolean()
            .nullable()
            .optional()
            .describe(
                "Whether reader authentication is required for mDoc requests.",
            ),
    })
    .describe("Payload for creating presentation verifier configuration.")
    .strict();

export const PresentationConfigUpdateSchema =
    PresentationConfigCreateSchema.partial()
        .describe("Payload for updating presentation verifier configuration.")
        .strict();
