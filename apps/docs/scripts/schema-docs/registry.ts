import type { z } from "zod";
import { CreateAttributeProviderSchema } from "../../../backend/src/issuer/configuration/attribute-provider/schemas/attribute-provider.schema.js";
import { CredentialConfigCreateSchema } from "../../../backend/src/issuer/configuration/credentials/schemas/credential-config.schema.js";
import { OfferRequestSchema } from "../../../backend/src/issuer/issuance/oid4vci/dto/offer-request.schema.js";
import {
    AwsKmsConfigSchema,
    CscKmsConfigSchema,
    DbKmsConfigSchema,
    HttpKmsConfigSchema,
    KmsConfigSchema,
    Pkcs11KmsConfigSchema,
    VaultKmsConfigSchema,
} from "../../../backend/src/crypto/key/schemas/kms-config.schema.js";
import { CreateOidcClientSchema } from "../../../backend/src/verifier/oidc-provider/schemas/oidc-client.schema.js";
import { PresentationRequestSchema } from "../../../backend/src/verifier/oid4vp/dto/presentation-request.schema.js";
import { PresentationConfigCreateSchema } from "../../../backend/src/verifier/presentations/schemas/presentation-config.schema.js";
import { TrustListCreateSchema } from "../../../backend/src/issuer/trust-list/schemas/trust-list.schema.js";

export interface SchemaDoc {
    /** File name of the model (`docs/_generated/schemas/<name>.json`) and the `name` prop of `<SchemaReference>`. */
    name: string;
    /** The Zod schema the backend validates with; the docs are generated from it. */
    schema: z.ZodType;
    /**
     * Corrected descriptions by field path (`a.b`; arrays and union variants
     * are crossed implicitly, and a field in several variants gets the
     * description in each). Only for descriptions frozen in a published config file
     * format: changing them in the schema would change the format snapshot
     * under `schemas/v*`. Fix them in the schema with the next format version.
     */
    descriptions?: Record<string, string>;
}

/** For credential fields published before secret references existed. */
const REFERENCE_OR_PLACEHOLDER =
    "Supports ${ENV_VAR} placeholders and, with a secret policy, secret references such as ${vault:…} (see Secret references).";
const REFERENCE_ONLY =
    "With a secret policy, it can be a secret reference such as ${vault:…} (see Secret references).";

// The published KmsConfig v2 text says the list limits new key chains only; imports are limited too.
// It also predates the limits of a tenant kms.json: listed files and AWS credentials of its own.
const kmsProviderDescriptions = {
    algorithms:
        "Signing algorithms new and imported key chains of this provider may use: ES256 (P-256), ES384 (P-384), ES512 (P-521). An import through the API, the config folder or a configuration bundle whose key uses another algorithm is refused. Defaults to all three for db, vault and aws-kms. For pkcs11, http and csc, whose backends may not support every curve, it defaults to defaultAlgorithm (ES256 unless set). Existing keys keep signing with their own algorithm.",
};
// Published before secret references: their credentials can be references.
const vaultKmsDescriptions = {
    ...kmsProviderDescriptions,
    vaultToken: `Authentication token for HashiCorp Vault. ${REFERENCE_OR_PLACEHOLDER}`,
};
const cscKmsDescriptions = {
    ...kmsProviderDescriptions,
    clientSecret: `OAuth2 client secret. ${REFERENCE_OR_PLACEHOLDER}`,
    sad: `Static SAD token. If set, the adapter sends it directly in signatures/signHash requests. ${REFERENCE_ONLY}`,
    "authorizeAuthData.value": `Authentication factor value sent to CSC credentials/authorize. ${REFERENCE_ONLY}`,
};
const awsKmsDescriptions = {
    ...kmsProviderDescriptions,
    accessKeyId:
        "AWS access key ID. Optional in the global kms.json, which then uses the AWS SDK default credential chain; required in a tenant kms.json unless KMS_TENANT_AWS_DEFAULT_CREDENTIALS is set and both values are omitted. Supports ${ENV_VAR} placeholders.",
    secretAccessKey:
        `AWS secret access key. Optional in the global kms.json, which then uses the AWS SDK default credential chain; required in a tenant kms.json unless KMS_TENANT_AWS_DEFAULT_CREDENTIALS is set and both values are omitted. ${REFERENCE_OR_PLACEHOLDER}`,
};
const pkcs11KmsDescriptions = {
    ...kmsProviderDescriptions,
    pin: `User PIN used for C_Login. ${REFERENCE_OR_PLACEHOLDER}`,
    library:
        "Absolute path to the PKCS#11 module library (.so/.dll/.dylib). In a tenant kms.json only a path listed in KMS_TENANT_FILES. Supports ${ENV_VAR} placeholders.",
};
const httpKmsDescriptions = {
    ...kmsProviderDescriptions,
    "auth.token": `Bearer token value. ${REFERENCE_OR_PLACEHOLDER}`,
    "auth.clientSecret": `OAuth 2.0 client secret. ${REFERENCE_OR_PLACEHOLDER}`,
    "auth.certFile":
        "Absolute path to the PEM-encoded client certificate file. In a tenant kms.json only a path listed in KMS_TENANT_FILES. Supports ${ENV_VAR} placeholders.",
    "auth.keyFile":
        "Absolute path to the PEM-encoded private key file for the client certificate. In a tenant kms.json only a path listed in KMS_TENANT_FILES. Supports ${ENV_VAR} placeholders.",
    "auth.caFile":
        "Absolute path to the PEM-encoded CA bundle to trust for the remote server's certificate. Omit to use the system CA store. In a tenant kms.json only a path listed in KMS_TENANT_FILES.",
};

/**
 * Zod schemas rendered in the docs. Add an entry here, run
 * `pnpm --filter @eudiplo/docs run prebuild`, then use
 * `<SchemaReference name="<name>" mode="table" />` (field table) or
 * `mode="body"` (annotated JSONC sample) on a page.
 */
export const schemaDocs: SchemaDoc[] = [
    { name: "presentation-request", schema: PresentationRequestSchema },
    {
        name: "credential-configuration",
        schema: CredentialConfigCreateSchema,
        descriptions: {
            revokeWithWalletUnit:
                "Revoke issued credentials when a wallet unit attestation they were bound to is revoked: the key attestation of the proof, or the wallet attestation accepted at the token endpoint of the built-in authorization server. Requires statusManagement and config.keyAttestationsRequired.",
        },
    },
    // One entry of `fields[]`; recursive (`children`), so it gets its own table.
    { name: "credential-field", schema: CredentialConfigCreateSchema.shape.fields.element },
    { name: "offer-request", schema: OfferRequestSchema },
    {
        name: "attribute-provider",
        schema: CreateAttributeProviderSchema,
        descriptions: {
            url: "URL that EUDIPLO posts the claim requests to, as is.",
            "auth.config.value": `API key value. ${REFERENCE_ONLY}`,
        },
    },
    {
        name: "presentation-configuration",
        schema: PresentationConfigCreateSchema,
        descriptions: {
            accessKeyChainId:
                "Access key chain that signs the request, determines the `client_id` and signs `readerAuth`; without it, an access key chain of the tenant is used.",
            "registration_cert.jwt":
                "Registration certificate JWT issued by a registrar. Attached to every request object as is; it must be valid, be issued to the relying party of the access certificate that signs the request (`sub`, or `intermediary.sub` with an intermediary), and authorize every credential the DCQL query requests.",
        },
    },
    { name: "oidc-client", schema: CreateOidcClientSchema },
    { name: "trust-list", schema: TrustListCreateSchema },
    { name: "kms-config", schema: KmsConfigSchema },
    { name: "kms-provider-db", schema: DbKmsConfigSchema, descriptions: kmsProviderDescriptions },
    { name: "kms-provider-vault", schema: VaultKmsConfigSchema, descriptions: vaultKmsDescriptions },
    { name: "kms-provider-aws-kms", schema: AwsKmsConfigSchema, descriptions: awsKmsDescriptions },
    { name: "kms-provider-pkcs11", schema: Pkcs11KmsConfigSchema, descriptions: pkcs11KmsDescriptions },
    { name: "kms-provider-http", schema: HttpKmsConfigSchema, descriptions: httpKmsDescriptions },
    { name: "kms-provider-csc", schema: CscKmsConfigSchema, descriptions: cscKmsDescriptions },
];
