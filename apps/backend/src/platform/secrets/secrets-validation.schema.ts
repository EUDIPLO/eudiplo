import Joi from "joi";

/**
 * Settings of secret references (`${env:…}`, `${vault:…}`) in the secret
 * fields: webhook endpoints, attribute providers, upstream client secrets
 * and KMS provider credentials.
 */
export const SECRETS_VALIDATION_SCHEMA = Joi.object({
    SECRET_POLICY_FILE: Joi.string()
        .optional()
        .allow("")
        .description(
            "Path to the secret policy file, which lists the secret sources and what the instance and each tenant may name. When unset, secret references are not read: values such as ${vault:…} are stored and sent as text, as before.",
        )
        .meta({ group: "secrets", order: 10 }),
    SECRET_VAULT_TOKEN: Joi.string()
        .optional()
        .allow("")
        .description(
            'Vault token of the vault source, when the policy file sets sources.vault.auth.method to "token".',
        )
        .meta({ group: "secrets", order: 20, secret: true }),
    SECRET_VAULT_ROLE_ID: Joi.string()
        .optional()
        .allow("")
        .description(
            'AppRole role ID of the vault source, when the policy file sets sources.vault.auth.method to "approle".',
        )
        .meta({ group: "secrets", order: 30 }),
    SECRET_VAULT_SECRET_ID: Joi.string()
        .optional()
        .allow("")
        .description(
            'AppRole secret ID of the vault source, when the policy file sets sources.vault.auth.method to "approle".',
        )
        .meta({ group: "secrets", order: 40, secret: true }),
});
