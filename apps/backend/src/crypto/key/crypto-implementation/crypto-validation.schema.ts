import Joi from "joi";

export const CRYPTO_VALIDATION_SCHEMA = Joi.object({
    CRYPTO_TOLERANCE: Joi.number()
        .default(5)
        .description("Clock tolerance in seconds for JWT verification")
        .meta({ group: "crypto", order: 20 }),
    KMS_TENANT_VARIABLES: Joi.string()
        .pattern(/^\s*([A-Z0-9_]+\s*(,\s*[A-Z0-9_]+\s*)*)?$/)
        .optional()
        .allow("")
        .description(
            "Comma-separated names of environment variables that tenant `kms.json` files may use as `${VAR}` placeholders. Every tenant may use every listed variable. Empty: a tenant `kms.json` resolves no variable of its own. Settings of EUDIPLO itself cannot be listed, apart from `PUBLIC_URL`, which needs no entry",
        )
        .meta({ group: "crypto", order: 30 }),
    KMS_TENANT_FILES: Joi.string()
        .optional()
        .allow("")
        .description(
            "Comma-separated absolute paths of files on the backend's host that tenant `kms.json` files may name: the `library` of a `pkcs11` provider and the mTLS `certFile`, `keyFile` and `caFile` of an `http` provider. Every tenant file may name every listed file. Empty: a tenant `kms.json` can hold neither a `pkcs11` provider nor mTLS authentication",
        )
        .meta({ group: "crypto", order: 31 }),
    KMS_TENANT_AWS_DEFAULT_CREDENTIALS: Joi.boolean()
        .default(false)
        .description(
            "Whether tenant `kms.json` files may hold `aws-kms` providers without `accessKeyId` and `secretAccessKey`. Such a provider calls AWS KMS with the AWS identity of the backend (IAM role, IRSA, `AWS_*` variables). Every tenant file may hold one, but only the operator can add it: the API accepts no new one",
        )
        .meta({ group: "crypto", order: 32 }),
});
