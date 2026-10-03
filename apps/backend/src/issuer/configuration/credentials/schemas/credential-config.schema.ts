import { z } from "zod";
import {
    ACTIVE_CREDENTIALS_REQUIRE_STATUS_MANAGEMENT,
    activeCredentialsLackStatusManagement,
} from "../domain/active-credential-policy.js";

const FieldDisplaySchema = z
    .object({
        locale: z.string().min(1).describe("Locale tag for the display entry."),
        name: z.string().min(1).describe("Human-readable field name."),
        description: z
            .string()
            .optional()
            .describe("Optional field description for this locale."),
    })
    .describe("Localized display metadata for a claim field.")
    .strict();

const ClaimFieldDefinitionSchema: z.ZodTypeAny = z.lazy(() =>
    z
        .object({
            path: z
                .array(z.union([z.string(), z.number(), z.null()]))
                .describe("Path to this claim inside the credential payload."),
            type: z
                .enum([
                    "string",
                    "number",
                    "integer",
                    "boolean",
                    "object",
                    "array",
                ])
                .describe("Data type of the claim value."),
            defaultValue: z
                .unknown()
                .optional()
                .describe("Optional default value for this field."),
            mandatory: z
                .boolean()
                .optional()
                .describe("Whether the field is required at issuance time."),
            disclosable: z
                .boolean()
                .optional()
                .describe("Whether the claim is selectively disclosable."),
            namespace: z
                .string()
                .optional()
                .describe("Optional namespace for claim grouping."),
            display: z
                .array(FieldDisplaySchema)
                .optional()
                .describe("Localized display metadata for this field."),
            constraints: z
                .record(z.string(), z.unknown())
                .optional()
                .describe(
                    "Optional validation constraints for the claim value.",
                ),
            children: z
                .array(ClaimFieldDefinitionSchema)
                .optional()
                .describe(
                    "Nested child claim definitions for object or array fields.",
                ),
        })
        .describe("Claim field definition.")
        .strict(),
);

const KeyAttestationsRequiredSchema = z
    .object({
        key_storage: z
            .array(z.string())
            .optional()
            .describe("Required key storage attestations."),
        user_authentication: z
            .array(z.string())
            .optional()
            .describe("Required user authentication attestations."),
    })
    .describe("Required key attestation capabilities.")
    .strict();

export const VctSchema = z
    .object({
        vct: z.string().optional().describe("VCT identifier."),
        name: z.string().optional().describe("Human-readable VCT name."),
        description: z
            .string()
            .optional()
            .describe("Optional VCT description."),
        extends: z.string().optional().describe("Optional base VCT reference."),
        "extends#integrity": z
            .string()
            .optional()
            .describe("Integrity hash for the extends reference."),
        schema_uri: z
            .string()
            .optional()
            .describe("Optional schema URI for the VCT."),
        "schema_uri#integrity": z
            .string()
            .optional()
            .describe("Integrity hash for schema_uri."),
    })
    .describe("Structured VCT metadata.")
    .strict();

const IaeActionOpenid4vpPresentationSchema = z
    .object({
        type: z
            .literal("openid4vp_presentation")
            .describe("Trigger an OpenID4VP presentation action."),
        label: z
            .string()
            .optional()
            .describe("Optional UI label for the action."),
        presentationConfigId: z
            .string()
            .min(1)
            .describe("Presentation configuration id to execute."),
    })
    .describe("IAE action to request a presentation.")
    .strict();

const IaeActionRedirectToWebSchema = z
    .object({
        type: z
            .literal("redirect_to_web")
            .describe("Trigger a redirect-to-web action."),
        label: z
            .string()
            .optional()
            .describe("Optional UI label for the action."),
        url: z.url().describe("Destination URL for the redirect action."),
        callbackUrl: z
            .url()
            .optional()
            .describe("Optional callback URL after redirect completion."),
        description: z
            .string()
            .optional()
            .describe("Optional action description."),
    })
    .describe("IAE action to redirect to an external web flow.")
    .strict();

const PolicyCredentialSchema = z
    .object({
        claims: z
            .array(z.unknown())
            .optional()
            .describe("Claims constraints considered by policy evaluation."),
        credentials: z
            .array(z.unknown())
            .describe(
                "Credential constraints considered by policy evaluation.",
            ),
        credential_sets: z
            .array(z.unknown())
            .optional()
            .describe("Optional credential set constraints."),
    })
    .describe("Credential policy requirement entry.")
    .strict();

const AllowListPolicySchema = z
    .object({
        policy: z
            .literal("allowList")
            .describe("Allow-list based policy discriminator."),
        values: z
            .array(z.string())
            .describe("Allowed values for policy checks."),
    })
    .describe("Allow-list disclosure policy.")
    .strict();

const RootOfTrustPolicySchema = z
    .object({
        policy: z
            .literal("rootOfTrust")
            .describe("Root-of-trust policy discriminator."),
        values: z.string().describe("Root-of-trust identifier or reference."),
    })
    .describe("Root-of-trust disclosure policy.")
    .strict();

const NoneTrustPolicySchema = z
    .object({
        policy: z.literal("none").describe("No disclosure policy enforcement."),
    })
    .describe("No disclosure policy.")
    .strict();

const AttestationBasedPolicySchema = z
    .object({
        policy: z
            .literal("attestationBased")
            .describe("Attestation-based policy discriminator."),
        values: z
            .array(PolicyCredentialSchema)
            .describe("Attestation requirements used for policy enforcement."),
    })
    .describe("Attestation-based disclosure policy.")
    .strict();

const SchemaUriEntrySchema = z
    .object({
        credentialConfigId: z
            .string()
            .optional()
            .describe(
                "Optional credential configuration id this schema URI applies to.",
            ),
        format: z
            .string()
            .optional()
            .describe("Optional credential format for this schema URI."),
        uri: z.string().optional().describe("Schema URI reference."),
        meta: z
            .record(z.string(), z.unknown())
            .optional()
            .describe("Optional metadata attached to the schema URI."),
    })
    .describe("Schema URI mapping entry.")
    .strict();

const TrustAuthorityEntrySchema = z
    .object({
        trustListId: z.string().optional().describe("Optional trust list id."),
        frameworkType: z
            .enum(["aki", "etsi_tl", "openid_federation"])
            .optional()
            .describe("Trust framework type."),
        value: z
            .string()
            .optional()
            .describe("Framework-specific authority value."),
        verificationMethod: z
            .union([z.record(z.string(), z.unknown()), z.string()])
            .optional()
            .describe("Verification method descriptor."),
    })
    .describe("Trusted authority mapping entry.")
    .strict();

const SchemaMetaConfigSchema = z
    .object({
        id: z
            .string()
            .optional()
            .describe("Optional schema metadata identifier."),
        name: z.string().optional().describe("Optional schema metadata name."),
        version: z.string().describe("Schema metadata version."),
        rulebookURI: z
            .string()
            .optional()
            .describe("Optional rulebook URI reference."),
        attestationLoS: z
            .enum([
                "iso_18045_high",
                "iso_18045_moderate",
                "iso_18045_enhanced-basic",
                "iso_18045_basic",
            ])
            .describe("Assurance level for attestation requirements."),
        bindingType: z
            .enum(["claim", "key", "biometric", "none"])
            .describe("Subject binding type."),
        schemaURIs: z
            .array(SchemaUriEntrySchema)
            .optional()
            .describe("Optional schema URI entries."),
        trustedAuthorities: z
            .array(TrustAuthorityEntrySchema)
            .optional()
            .describe("Optional trusted authority entries."),
    })
    .describe("Schema metadata configuration.")
    .strict();

const DisplayImageSchema = z
    .object({
        uri: z.string().min(1).describe("Image URI."),
    })
    .describe("Display image reference.")
    .strict();

const CredentialDisplaySchema = FieldDisplaySchema.extend({
    background_color: z
        .string()
        .optional()
        .describe("Optional background color for card-style rendering."),
    text_color: z
        .string()
        .optional()
        .describe("Optional text color for card-style rendering."),
    background_image: DisplayImageSchema.optional().describe(
        "Optional background image.",
    ),
    logo: DisplayImageSchema.optional().describe("Optional logo image."),
}).strict();

const CredentialReusePolicyOptionSchema = z
    .object({
        details: z
            .array(
                z.enum([
                    "once_only",
                    "limited_time",
                    "limited-time",
                    "rotating-batch",
                    "per-relying-party",
                ]),
            )
            .min(1),
        batch_size: z.number().int().min(2).optional(),
        reissue_trigger_unused: z.number().int().min(0).optional(),
        reissue_trigger_lifetime_left: z.number().int().min(0).optional(),
    })
    .strict()
    .superRefine((option, context) => {
        const details = new Set(option.details);
        if (
            (details.has("once_only") ||
                details.has("rotating-batch") ||
                details.has("per-relying-party")) &&
            option.batch_size === undefined
        ) {
            context.addIssue({
                code: "custom",
                path: ["batch_size"],
                message: "batch_size is required for this reuse policy",
            });
        }
        if (details.has("once_only")) {
            if (option.reissue_trigger_unused === undefined) {
                context.addIssue({
                    code: "custom",
                    path: ["reissue_trigger_unused"],
                    message: "reissue_trigger_unused is required for once_only",
                });
            } else if (
                option.batch_size !== undefined &&
                option.reissue_trigger_unused >= option.batch_size
            ) {
                context.addIssue({
                    code: "custom",
                    path: ["reissue_trigger_unused"],
                    message: "must be lower than batch_size",
                });
            }
        }
        if (
            (details.has("limited_time") ||
                details.has("limited-time") ||
                details.has("rotating-batch") ||
                details.has("per-relying-party")) &&
            option.reissue_trigger_lifetime_left === undefined
        ) {
            context.addIssue({
                code: "custom",
                path: ["reissue_trigger_lifetime_left"],
                message:
                    "reissue_trigger_lifetime_left is required for this reuse policy",
            });
        }
    });

export const CredentialReusePolicySchema = z
    .object({
        id: z.string().min(1),
        options: z.array(CredentialReusePolicyOptionSchema).optional(),
    })
    .strict()
    .superRefine((policy, context) => {
        if (policy.id === "arf_annex_ii" && !policy.options) {
            context.addIssue({
                code: "custom",
                path: ["options"],
                message: "options is required for arf_annex_ii",
            });
        }
    });

export const ActiveCredentialPolicySchema = z
    .object({
        enabled: z
            .boolean()
            .describe(
                "Ensure a subject has at most one active credential of this configuration.",
            ),
        tracking: z
            .enum(["internal"])
            .optional()
            .describe(
                "How the subject's active credential set is tracked. Only 'internal' (pseudonymous, issuer-side) is currently supported.",
            ),
    })
    .strict()
    .describe(
        "Issuer-side policy limiting the number of simultaneously active credentials per subject.",
    );

const IssuerMetadataCredentialConfigSchema = z
    .object({
        format: z
            .enum(["mso_mdoc", "dc+sd-jwt"])
            .describe("Credential format emitted by this configuration."),
        display: z
            .array(CredentialDisplaySchema)
            .describe("Display metadata shown by wallets."),
        scope: z
            .string()
            .optional()
            .describe(
                "Optional OAuth scope associated with this credential type.",
            ),
        docType: z.string().optional().describe("Optional mDoc document type."),
        keyAttestationsRequired:
            KeyAttestationsRequiredSchema.optional().describe(
                "Optional key attestation requirements.",
            ),
        proofTypesSupported: z
            .array(z.enum(["jwt", "attestation"]))
            .optional()
            .describe("Supported proof types for issuance requests."),
        credentialReusePolicy: CredentialReusePolicySchema.optional().describe(
            "Optional PID/EAA reuse policy published in credential metadata.",
        ),
    })
    .describe("Credential metadata configuration exposed by issuer metadata.")
    .strict();

const IaeActionSchema = z
    .discriminatedUnion("type", [
        IaeActionOpenid4vpPresentationSchema,
        IaeActionRedirectToWebSchema,
    ])
    .describe("In-app experience action definitions.");

export const EmbeddedDisclosurePolicySchema = z
    .discriminatedUnion("policy", [
        AttestationBasedPolicySchema,
        NoneTrustPolicySchema,
        AllowListPolicySchema,
        RootOfTrustPolicySchema,
    ])
    .describe("Embedded disclosure policy configuration.");

export const CredentialConfigCreateSchema = z
    .object({
        id: z.string().min(1).describe("Credential configuration identifier."),
        description: z
            .string()
            .nullable()
            .optional()
            .describe("Optional description for operators and tooling."),
        config: IssuerMetadataCredentialConfigSchema.describe(
            "Issuer metadata-facing credential configuration.",
        ),
        fields: z
            .array(ClaimFieldDefinitionSchema)
            .describe("Claim field definitions for credential issuance."),
        attributeProviderId: z
            .string()
            .nullable()
            .optional()
            .describe(
                "Optional attribute provider id used to resolve claim values.",
            ),
        webhookEndpointId: z
            .string()
            .nullable()
            .optional()
            .describe(
                "Optional webhook endpoint id notified during issuance events.",
            ),
        vct: z
            .union([z.string(), VctSchema, z.null()])
            .optional()
            .describe("Optional VCT value or structured VCT metadata."),
        keyBinding: z
            .boolean()
            .optional()
            .describe("Enable key binding requirements."),
        keyChainId: z
            .string()
            .min(1)
            .optional()
            .describe("Optional key chain id used for credential signing."),
        statusManagement: z
            .boolean()
            .optional()
            .describe("Enable status management for issued credentials."),
        activeCredentials: ActiveCredentialPolicySchema.nullable()
            .optional()
            .describe(
                "Optional issuer-side policy limiting simultaneously active credentials per subject. Requires statusManagement.",
            ),
        iaeActions: z
            .array(IaeActionSchema)
            .nullable()
            .optional()
            .describe("Optional in-app experience actions for wallet flows."),
        sdJwtTrustFormat: z
            .enum(["x5c", "federation"])
            .nullable()
            .optional()
            .describe("Trust format used for SD-JWT verification metadata."),
        lifeTime: z.coerce
            .number()
            .int()
            .min(1)
            .optional()
            .describe("Credential lifetime in seconds."),
        schemaMeta: SchemaMetaConfigSchema.nullable()
            .optional()
            .describe("Optional schema metadata and trust bindings."),
        embeddedDisclosurePolicy: EmbeddedDisclosurePolicySchema.nullable()
            .optional()
            .describe("Optional embedded disclosure policy."),
    })
    .strict()
    .superRefine((value, context) => {
        if (activeCredentialsLackStatusManagement(value)) {
            context.addIssue({
                code: "custom",
                path: ["statusManagement"],
                message: ACTIVE_CREDENTIALS_REQUIRE_STATUS_MANAGEMENT,
            });
        }
    })
    .describe("Payload for creating credential issuance configuration.");
