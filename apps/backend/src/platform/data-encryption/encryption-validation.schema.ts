import Joi from "joi";

/**
 * Validation schema for encryption key source configuration.
 *
 * Configures where the encryption key for data at rest is fetched from:
 * - env (default): Derived from MASTER_SECRET (development only)
 * - vault: Fetched from HashiCorp Vault (production)
 * - aws: Fetched from AWS Secrets Manager (production)
 * - azure: Fetched from Azure Key Vault (production)
 */
export const ENCRYPTION_VALIDATION_SCHEMA = Joi.object({
    ENCRYPTION_KEY_SOURCE: Joi.string()
        .valid("env", "vault", "aws", "azure")
        .default("env")
        .description(
            "Source for encryption key: env (dev), vault/aws/azure (prod - key only in RAM)",
        )
        .meta({ group: "encryption", order: 10 }),

    // Vault-related config. VAULT_ADDR and VAULT_TOKEN can also be referenced
    // from kms.json (`${VAULT_ADDR}`), so they are not required here.
    VAULT_ADDR: Joi.string()
        .optional()
        .allow("")
        .description(
            "URL of the HashiCorp Vault server, e.g. http://vault:8200. Required when ENCRYPTION_KEY_SOURCE=vault",
        )
        .meta({ group: "encryption", order: 15 }),
    VAULT_TOKEN: Joi.string()
        .optional()
        .allow("")
        .description(
            "Token for the HashiCorp Vault server. Required when ENCRYPTION_KEY_SOURCE=vault",
        )
        .meta({ group: "encryption", order: 16, secret: true }),
    VAULT_ENCRYPTION_KEY_PATH: Joi.string()
        .when("ENCRYPTION_KEY_SOURCE", {
            is: "vault",
            then: Joi.optional().default("secret/data/eudiplo/encryption-key"),
            otherwise: Joi.optional(),
        })
        .description("Path to encryption key in Vault KV secrets engine")
        .meta({ group: "encryption", order: 20 }),

    // AWS Secrets Manager config. AWS_REGION is also read by the AWS SDK and
    // can be referenced from kms.json (`${AWS_REGION}`).
    AWS_REGION: Joi.string()
        .optional()
        .allow("")
        .description(
            "AWS region, e.g. eu-central-1. Required when ENCRYPTION_KEY_SOURCE=aws",
        )
        .meta({ group: "encryption", order: 25 }),
    AWS_ENCRYPTION_SECRET_NAME: Joi.string()
        .when("ENCRYPTION_KEY_SOURCE", {
            is: "aws",
            then: Joi.required(),
            otherwise: Joi.optional(),
        })
        .description("Name of the encryption key secret in AWS Secrets Manager")
        .meta({ group: "encryption", order: 30 }),
    AWS_ENCRYPTION_SECRET_KEY: Joi.string()
        .when("ENCRYPTION_KEY_SOURCE", {
            is: "aws",
            then: Joi.optional().default("key"),
            otherwise: Joi.optional(),
        })
        .description("JSON key within the AWS secret (if secret is JSON)")
        .meta({ group: "encryption", order: 40 }),

    // Azure Key Vault config
    AZURE_KEYVAULT_URL: Joi.string()
        .uri()
        .when("ENCRYPTION_KEY_SOURCE", {
            is: "azure",
            then: Joi.required(),
            otherwise: Joi.optional(),
        })
        .description(
            "Azure Key Vault URL (e.g., https://myvault.vault.azure.net)",
        )
        .meta({ group: "encryption", order: 50 }),
    AZURE_ENCRYPTION_SECRET_NAME: Joi.string()
        .when("ENCRYPTION_KEY_SOURCE", {
            is: "azure",
            then: Joi.required(),
            otherwise: Joi.optional(),
        })
        .description("Name of the encryption key secret in Azure Key Vault")
        .meta({ group: "encryption", order: 60 }),
});
