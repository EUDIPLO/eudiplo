import type { z } from "zod";
import { CreateAttributeProviderSchema } from "../../../backend/src/issuer/configuration/attribute-provider/schemas/attribute-provider.schema.js";
import { CredentialConfigCreateSchema } from "../../../backend/src/issuer/configuration/credentials/schemas/credential-config.schema.js";
import { SignSchemaMetaConfigSchema } from "../../../backend/src/issuer/configuration/credentials/dto/schema-meta-config.schema.js";
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

// The published KmsConfig v2 text says the list limits new key chains only; imports are limited too.
const kmsProviderDescriptions = {
    algorithms:
        "Signing algorithms new and imported key chains of this provider may use: ES256 (P-256), ES384 (P-384), ES512 (P-521). An import through the API, the config folder or a configuration bundle whose key uses another algorithm is refused. Defaults to all three for db, vault and aws-kms. For pkcs11, http and csc, whose backends may not support every curve, it defaults to defaultAlgorithm (ES256 unless set). Existing keys keep signing with their own algorithm.",
};

/**
 * Zod schemas rendered in the docs. Add an entry here, run
 * `pnpm --filter @eudiplo/docs run prebuild`, then use
 * `<SchemaReference name="<name>" mode="table" />` (field table) or
 * `mode="body"` (annotated JSONC sample) on a page.
 */
export const schemaDocs: SchemaDoc[] = [
    { name: "presentation-request", schema: PresentationRequestSchema },
    { name: "credential-configuration", schema: CredentialConfigCreateSchema },
    // One entry of `fields[]`; recursive (`children`), so it gets its own table.
    { name: "credential-field", schema: CredentialConfigCreateSchema.shape.fields.element },
    { name: "offer-request", schema: OfferRequestSchema },
    {
        name: "attribute-provider",
        schema: CreateAttributeProviderSchema,
        descriptions: { url: "URL that EUDIPLO posts the claim requests to, as is." },
    },
    {
        name: "presentation-configuration",
        schema: PresentationConfigCreateSchema,
        descriptions: {
            accessKeyChainId:
                "Access key chain that signs the request, determines the `client_id` and signs `readerAuth`; without it, an access key chain of the tenant is used.",
        },
    },
    { name: "trust-list", schema: TrustListCreateSchema },
    { name: "schema-metadata-publish", schema: SignSchemaMetaConfigSchema },
    { name: "kms-config", schema: KmsConfigSchema },
    { name: "kms-provider-db", schema: DbKmsConfigSchema, descriptions: kmsProviderDescriptions },
    { name: "kms-provider-vault", schema: VaultKmsConfigSchema, descriptions: kmsProviderDescriptions },
    { name: "kms-provider-aws-kms", schema: AwsKmsConfigSchema, descriptions: kmsProviderDescriptions },
    { name: "kms-provider-pkcs11", schema: Pkcs11KmsConfigSchema, descriptions: kmsProviderDescriptions },
    { name: "kms-provider-http", schema: HttpKmsConfigSchema, descriptions: kmsProviderDescriptions },
    { name: "kms-provider-csc", schema: CscKmsConfigSchema, descriptions: kmsProviderDescriptions },
];
