import { z } from "zod";

const NonBlankStringSchema = z.string().trim().min(1);

/**
 * The tenant's key chain per usage type, used where no configuration names
 * one: the spec of the KeyChainDefaults configuration resource
 * (`key-chain-defaults.json`).
 */
export const DefaultKeyChainsSchema = z
    .strictObject({
        access: NonBlankStringSchema.optional().describe(
            "ID of the access key chain used where no configuration names one: presentation requests of configurations without accessKeyChainId and the signed issuer metadata. Without it, EUDIPLO picks one of the tenant's access key chains by rule.",
        ),
        accessToken: NonBlankStringSchema.optional().describe(
            "ID of the access token key chain (usage type accessToken) that signs the access tokens of authorization servers without token.signingKeyId and is published in their JWKS. Without it, EUDIPLO uses the tenant's oldest access token key chain and creates one with ID access-token when the tenant has none.",
        ),
    })
    .describe(
        "The tenant's key chain per usage type, used where no configuration names one. A usage type without an entry uses a key chain picked by rule.",
    );

const KeyChainDefaultsConfigMetadataSchema = z
    .object({
        generation: z.number().int().min(1).optional(),
        ownership: z.enum(["unmanaged", "file-managed"]).optional(),
    })
    .strict();

export const KeyChainDefaultsConfigFileSchema = z.union([
    z.strictObject({
        $schema: z.literal(
            "https://eudiplo.dev/schemas/v1/KeyChainDefaultsConfigFile.schema.json",
        ),
        metadata: KeyChainDefaultsConfigMetadataSchema,
        spec: DefaultKeyChainsSchema,
    }),
    DefaultKeyChainsSchema,
]);
