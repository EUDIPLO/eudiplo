import { z } from "zod";
import {
    booleanField,
    createValidationException,
    findMissingEnvPlaceholderIssues,
    optionalTextField,
    resolveEnvPlaceholders,
    textField,
    toValidationIssues,
    urlField,
    withMeta,
} from "../../../shared/common/zod/zod-schema.util.js";

/**
 * Fields that hold credentials. Their values are never returned by the API
 * and are replaced by placeholders in configuration bundle exports; see
 * {@link KMS_SECRET_PATHS}.
 */
const secretFields = new WeakSet<z.ZodType>();

function secretField<T extends z.ZodType>(schema: T): T {
    secretFields.add(schema);
    return schema;
}

const KMS_PROVIDER_TYPES = [
    "db",
    "vault",
    "aws-kms",
    "pkcs11",
    "http",
    "csc",
] as const;

const HttpAuthNoneConfigSchema = z.strictObject({
    type: withMeta(z.literal("none"), {
        description:
            "No authentication — suitable for services on a trusted private network.",
        examples: ["none"],
    }),
});

export const HttpAuthBearerConfigSchema = z.strictObject({
    type: withMeta(z.literal("bearer"), {
        description:
            "Static Bearer token sent as Authorization: Bearer <token>.",
        examples: ["bearer"],
    }),
    token: secretField(
        textField(
            "Bearer token value. Supports ${ENV_VAR} placeholders.",
            "${KMS_API_KEY}",
        ),
    ),
});

export const HttpAuthOauth2ConfigSchema = z.strictObject({
    type: withMeta(z.literal("oauth2-client-credentials"), {
        description:
            "OAuth 2.0 Client Credentials — EUDIPLO fetches and caches short-lived tokens.",
        examples: ["oauth2-client-credentials"],
    }),
    tokenUrl: urlField(
        "Token endpoint URL (e.g. Keycloak, Entra ID). Supports ${ENV_VAR} placeholders.",
        "${IAM_TOKEN_URL}",
    ),
    clientId: textField(
        "OAuth 2.0 client ID. Supports ${ENV_VAR} placeholders.",
        "${KMS_CLIENT_ID}",
    ),
    clientSecret: secretField(
        textField(
            "OAuth 2.0 client secret. Supports ${ENV_VAR} placeholders.",
            "${KMS_CLIENT_SECRET}",
        ),
    ),
    scope: optionalTextField(
        "Space-separated list of OAuth 2.0 scopes to request. Optional.",
        "kms:sign kms:admin",
    ),
});

export const HttpAuthMtlsConfigSchema = z.strictObject({
    type: withMeta(z.literal("mtls"), {
        description:
            "Mutual TLS — EUDIPLO presents a client certificate on every connection.",
        examples: ["mtls"],
    }),
    certFile: textField(
        "Absolute path to the PEM-encoded client certificate file. Supports ${ENV_VAR} placeholders.",
        "/etc/certs/eudiplo.crt",
    ),
    keyFile: textField(
        "Absolute path to the PEM-encoded private key file for the client certificate. Supports ${ENV_VAR} placeholders.",
        "/etc/certs/eudiplo.key",
    ),
    caFile: optionalTextField(
        "Absolute path to the PEM-encoded CA bundle to trust for the remote server's certificate. Omit to use the system CA store.",
        "/etc/certs/ca.crt",
    ),
});

export const HttpKmsAuthConfigSchema = z.discriminatedUnion("type", [
    HttpAuthNoneConfigSchema,
    HttpAuthBearerConfigSchema,
    HttpAuthOauth2ConfigSchema,
    HttpAuthMtlsConfigSchema,
]);

const BaseKmsProviderConfigSchema = z.strictObject({
    id: textField(
        "Unique identifier for this provider instance. Used when generating keys to specify which provider to use.",
        "main-vault",
    ),
    type: withMeta(z.enum(KMS_PROVIDER_TYPES), {
        description:
            "Type of the KMS provider. Must match a supported adapter type.",
        examples: ["vault"],
    }),
    description: optionalTextField(
        "Human-readable description of this provider instance.",
        "Production HashiCorp Vault for signing keys",
    ),
});

export const DbKmsConfigSchema = BaseKmsProviderConfigSchema.extend({
    type: withMeta(z.literal("db"), {
        description: "Type of the KMS provider.",
        examples: ["db"],
    }),
});

export const VaultKmsConfigSchema = BaseKmsProviderConfigSchema.extend({
    type: withMeta(z.literal("vault"), {
        description: "Type of the KMS provider.",
        examples: ["vault"],
    }),
    vaultUrl: urlField(
        "URL of the HashiCorp Vault instance. Supports ${ENV_VAR} placeholders.",
        "${VAULT_URL}",
    ),
    vaultToken: secretField(
        textField(
            "Authentication token for HashiCorp Vault. Supports ${ENV_VAR} placeholders.",
            "${VAULT_TOKEN}",
        ),
    ),
});

export const AwsKmsConfigSchema = BaseKmsProviderConfigSchema.extend({
    type: withMeta(z.literal("aws-kms"), {
        description: "Type of the KMS provider.",
        examples: ["aws-kms"],
    }),
    region: textField(
        "AWS region for KMS. Supports ${ENV_VAR} placeholders.",
        "${AWS_REGION}",
    ),
    accessKeyId: optionalTextField(
        "AWS access key ID. Optional — uses SDK credential chain if not provided. Supports ${ENV_VAR} placeholders.",
        "${AWS_ACCESS_KEY_ID}",
    ),
    secretAccessKey: secretField(
        optionalTextField(
            "AWS secret access key. Optional — uses SDK credential chain if not provided. Supports ${ENV_VAR} placeholders.",
            "${AWS_SECRET_ACCESS_KEY}",
        ),
    ),
});

export const Pkcs11KmsConfigSchema = BaseKmsProviderConfigSchema.extend({
    type: withMeta(z.literal("pkcs11"), {
        description: "Type of the KMS provider.",
        examples: ["pkcs11"],
    }),
    library: textField(
        "Absolute path to the PKCS#11 module library (.so/.dll/.dylib). Supports ${ENV_VAR} placeholders.",
        "${PKCS11_LIBRARY}",
    ),
    slot: withMeta(z.union([z.number(), z.string()]), {
        description:
            "Slot selection. Either the numeric slot index (as a string for ENV interpolation, or a number) or the token label. Supports ${ENV_VAR} placeholders.",
        examples: ["${PKCS11_SLOT}"],
    }),
    pin: secretField(
        textField(
            "User PIN used for C_Login. Supports ${ENV_VAR} placeholders.",
            "${PKCS11_PIN}",
        ),
    ),
    readOnly: booleanField(
        "Open the PKCS#11 session in read-only mode. Defaults to false.",
        false,
    ),
});

export const HttpKmsConfigSchema = BaseKmsProviderConfigSchema.extend({
    type: withMeta(z.literal("http"), {
        description: "Type of the KMS provider.",
        examples: ["http"],
    }),
    baseUrl: urlField(
        "Base URL of the remote KMS microservice (no trailing slash). Supports ${ENV_VAR} placeholders.",
        "${KMS_SERVICE_URL}",
    ),
    auth: withMeta(HttpKmsAuthConfigSchema.optional(), {
        description:
            'Authentication method for the remote KMS service. Supports bearer token, OAuth 2.0 client credentials, and mutual TLS. Omit (or set type to "none") for unauthenticated services.',
    }),
    keysPath: optionalTextField(
        "Path prefix for key endpoints on the remote service. Defaults to /keys.",
        "/v1/keys",
    ),
    healthPath: optionalTextField(
        "Path for the health check endpoint on the remote service. Defaults to /health.",
        "/health",
    ),
    canImport: booleanField(
        "Whether the remote service supports key import via POST {keysPath}/{kid}/import. Defaults to false.",
        false,
    ),
});

export type KmsProviderType = z.infer<
    typeof BaseKmsProviderConfigSchema.shape.type
>;

const CscAuthorizeAuthDataSchema = z.strictObject({
    id: textField(
        "Authentication factor identifier expected by the CSC provider (e.g., PIN, OTP).",
        "PIN",
    ),
    value: secretField(
        textField(
            "Authentication factor value sent to CSC credentials/authorize.",
            "123456",
        ),
    ),
});

export const CscKmsConfigSchema = BaseKmsProviderConfigSchema.extend({
    type: withMeta(z.literal("csc"), {
        description: "Type of the KMS provider.",
        examples: ["csc"],
    }),
    baseUrl: urlField(
        "Base URL of the CSC service (without trailing slash). Supports ${ENV_VAR} placeholders.",
        "${CSC_URL}",
    ),
    tokenUrl: urlField(
        "OAuth2 token endpoint URL for client-credentials flow. Supports ${ENV_VAR} placeholders.",
        "${CSC_TOKEN_URL}",
    ),
    clientId: textField(
        "OAuth2 client ID. Supports ${ENV_VAR} placeholders.",
        "${CSC_CLIENT_ID}",
    ),
    clientSecret: secretField(
        textField(
            "OAuth2 client secret. Supports ${ENV_VAR} placeholders.",
            "${CSC_CLIENT_SECRET}",
        ),
    ),
    scope: optionalTextField(
        "OAuth2 scope to request during token acquisition.",
        "service",
    ),
    credentialId: optionalTextField(
        "Default CSC credential ID. If omitted, the adapter calls credentials/list and picks the first entry.",
        "[INTESIQCSEALEC]_SEAL_351_SIGN_1781018892758",
    ),
    userId: optionalTextField(
        "Optional CSC user ID used in credentials/list requests.",
        "eudiplo_user",
    ),
    apiPath: optionalTextField(
        "CSC API path prefix appended to baseUrl. Defaults to /csc/v2.",
        "/csc/v2",
    ),
    hashAlgorithmOid: optionalTextField(
        "Hash algorithm OID for signatures/signHash and credentials/authorize. Defaults to SHA-256 OID.",
        "2.16.840.1.101.3.4.2.1",
    ),
    signAlgorithmOid: optionalTextField(
        "Signature algorithm OID for signatures/signHash. Defaults to ecdsa-with-SHA256 OID.",
        "1.2.840.10045.4.3.2",
    ),
    sad: secretField(
        optionalTextField(
            "Static SAD token. If set, the adapter sends it directly in signatures/signHash requests.",
        ),
    ),
    useAuthorizeEndpoint: booleanField(
        "When true and no static SAD is provided, the adapter calls credentials/authorize to obtain SAD before signatures/signHash.",
        false,
    ),
    authorizeAuthData: withMeta(
        z.array(CscAuthorizeAuthDataSchema).optional(),
        {
            description:
                "Optional authData array passed to credentials/authorize (e.g., PIN/OTP factors).",
        },
    ),
});

export const KmsProviderConfigSchema = z.discriminatedUnion("type", [
    DbKmsConfigSchema,
    VaultKmsConfigSchema,
    AwsKmsConfigSchema,
    Pkcs11KmsConfigSchema,
    HttpKmsConfigSchema,
    CscKmsConfigSchema,
]);

export const KmsConfigSchema = z
    .strictObject({
        defaultProvider: optionalTextField(
            'ID of the default KMS provider. Defaults to "db" if not set.',
            "main-vault",
        ),
        providers: withMeta(z.array(KmsProviderConfigSchema), {
            description:
                "List of KMS provider configurations. Each provider must have a unique id and a type.",
            examples: [
                [
                    {
                        id: "db",
                        type: "db",
                        description: "Default database provider",
                    },
                    {
                        id: "main-vault",
                        type: "vault",
                        description: "Production Vault",
                        vaultUrl: "${VAULT_URL}",
                        vaultToken: "${VAULT_TOKEN}",
                    },
                    {
                        id: "aws",
                        type: "aws-kms",
                        description: "AWS KMS",
                        region: "${AWS_REGION}",
                    },
                ],
            ],
        }),
    })
    .superRefine((config, ctx) => {
        const providerIds = new Map<string, number>();

        for (const [index, provider] of config.providers.entries()) {
            const previousIndex = providerIds.get(provider.id);
            if (previousIndex !== undefined) {
                ctx.addIssue({
                    code: "custom",
                    path: ["providers", index, "id"],
                    message: `Duplicate KMS provider id '${provider.id}' already used at providers[${previousIndex}]`,
                });
                continue;
            }

            providerIds.set(provider.id, index);
        }

        if (
            config.defaultProvider !== undefined &&
            !providerIds.has(config.defaultProvider)
        ) {
            ctx.addIssue({
                code: "custom",
                path: ["defaultProvider"],
                message: `defaultProvider '${config.defaultProvider}' does not match any configured provider id`,
            });
        }
    });

/**
 * Paths of the credential fields declared with `secretField`, in dotted form
 * with `*` for array items ("providers.*.vaultToken").
 */
function secretPaths(schema: z.ZodType, path: string[] = []): string[] {
    if (secretFields.has(schema)) return [path.join(".")];
    // Zod 4 schema definitions; only the wrappers used above are followed.
    const def = (schema as unknown as { _zod: { def: Record<string, any> } })
        ._zod.def;
    switch (def.type) {
        case "object":
            return Object.entries(
                def.shape as Record<string, z.ZodType>,
            ).flatMap(([key, field]) => secretPaths(field, [...path, key]));
        case "optional":
        case "nullable":
        case "default":
            return secretPaths(def.innerType, path);
        case "array":
            return secretPaths(def.element, [...path, "*"]);
        case "union":
            return (def.options as z.ZodType[]).flatMap((option) =>
                secretPaths(option, path),
            );
        default:
            return [];
    }
}

/**
 * Credential fields of a KMS configuration (`providers.*.vaultToken`, ...),
 * derived from the schema. Used to redact API responses and configuration
 * bundle exports.
 */
export const KMS_SECRET_PATHS: readonly string[] = [
    ...new Set(secretPaths(KmsConfigSchema)),
];

export type KmsProviderConfig = z.infer<typeof KmsProviderConfigSchema>;
export type KmsConfig = z.infer<typeof KmsConfigSchema>;

export function parseRawKmsConfig(
    input: unknown,
    source = "KMS configuration",
): KmsConfig {
    const parsed = KmsConfigSchema.safeParse(input);
    if (!parsed.success) {
        throw createValidationException(
            toValidationIssues(parsed.error.issues),
            source,
        );
    }

    return parsed.data;
}

export function parseResolvedKmsConfig(
    input: unknown,
    source = "KMS configuration",
): KmsConfig {
    const raw = parseRawKmsConfig(input, source);
    const missingEnvIssues = findMissingEnvPlaceholderIssues(raw);
    if (missingEnvIssues.length > 0) {
        const missingVariables = [
            ...new Set(
                missingEnvIssues
                    .map((issue) => issue.message.match(/'([^']+)'/)?.[1])
                    .filter((value): value is string => value !== undefined),
            ),
        ];
        throw createValidationException(
            missingEnvIssues,
            `${source}: Missing environment variables: ${missingVariables.join(", ")}`,
        );
    }

    const resolved = resolveEnvPlaceholders(raw);
    const parsed = KmsConfigSchema.safeParse(resolved);

    if (!parsed.success) {
        throw createValidationException(
            toValidationIssues(parsed.error.issues),
            `${source} after environment placeholder resolution`,
        );
    }

    return parsed.data;
}
