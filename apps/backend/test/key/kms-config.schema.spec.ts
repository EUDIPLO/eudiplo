import Ajv from "ajv/dist/2020";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
    AwsKmsConfigSchema,
    CscKmsConfigSchema,
    DbKmsConfigSchema,
    HttpAuthBearerConfigSchema,
    HttpAuthMtlsConfigSchema,
    HttpAuthOauth2ConfigSchema,
    HttpKmsAuthConfigSchema,
    HttpKmsConfigSchema,
    KmsConfigSchema,
    KmsProviderConfigSchema,
    Pkcs11KmsConfigSchema,
    parseResolvedKmsConfig,
    VaultKmsConfigSchema,
} from "../../src/crypto/key/schemas/kms-config.schema.js";

function validDbProvider() {
    return {
        id: "db",
        type: "db" as const,
        description: "Default database provider",
    };
}

function validVaultProvider() {
    return {
        id: "vault",
        type: "vault" as const,
        description: "Vault",
        vaultUrl: "https://vault.example.com",
        vaultToken: "token",
    };
}

function validAwsProvider() {
    return {
        id: "aws",
        type: "aws-kms" as const,
        description: "AWS",
        region: "eu-west-1",
    };
}

function validPkcs11Provider() {
    return {
        id: "pkcs11",
        type: "pkcs11" as const,
        library: "/usr/lib/softhsm/libsofthsm2.so",
        slot: "0",
        pin: "123456",
    };
}

function validHttpProvider() {
    return {
        id: "http",
        type: "http" as const,
        baseUrl: "https://kms.example.com",
    };
}

function validCscProvider() {
    return {
        id: "csc",
        type: "csc" as const,
        baseUrl: "https://csc.example.com",
        tokenUrl: "https://csc.example.com/token",
        clientId: "client-id",
        clientSecret: "client-secret",
    };
}

function validKmsConfig() {
    return {
        defaultProvider: "vault",
        providers: [
            validDbProvider(),
            validVaultProvider(),
            validAwsProvider(),
            validPkcs11Provider(),
            validHttpProvider(),
            validCscProvider(),
        ],
    };
}

function expectValid(
    schema: { safeParse: (value: unknown) => { success: boolean } },
    value: unknown,
) {
    const result = schema.safeParse(value);
    expect(result.success).toBe(true);
}

function expectInvalid(
    schema: {
        safeParse: (value: unknown) => {
            success: boolean;
            error?: {
                issues: Array<{
                    path: Array<string | number>;
                    message: string;
                }>;
            };
        };
    },
    value: unknown,
) {
    const result = schema.safeParse(value);
    expect(result.success).toBe(false);
}

function assertNoDiscriminator(node: unknown) {
    if (!node || typeof node !== "object") {
        return;
    }

    if (Array.isArray(node)) {
        for (const item of node) {
            assertNoDiscriminator(item);
        }
        return;
    }

    const record = node as Record<string, unknown>;
    expect(record.discriminator).toBeUndefined();
    for (const value of Object.values(record)) {
        assertNoDiscriminator(value);
    }
}

describe("KMS Zod schemas", () => {
    beforeEach(() => {
        vi.unstubAllEnvs();
    });

    it("accepts a valid configuration for every provider type", () => {
        expectValid(KmsConfigSchema, validKmsConfig());
        expectValid(DbKmsConfigSchema, validDbProvider());
        expectValid(VaultKmsConfigSchema, validVaultProvider());
        expectValid(AwsKmsConfigSchema, validAwsProvider());
        expectValid(Pkcs11KmsConfigSchema, validPkcs11Provider());
        expectValid(HttpKmsConfigSchema, validHttpProvider());
        expectValid(CscKmsConfigSchema, validCscProvider());
    });

    it("accepts every HTTP authentication variant", () => {
        expectValid(HttpKmsAuthConfigSchema, { type: "none" });
        expectValid(HttpKmsAuthConfigSchema, {
            type: "bearer",
            token: "token",
        });
        expectValid(HttpKmsAuthConfigSchema, {
            type: "oauth2-client-credentials",
            tokenUrl: "https://iam.example.com/token",
            clientId: "client-id",
            clientSecret: "client-secret",
            scope: "kms:sign kms:admin",
        });
        expectValid(HttpKmsAuthConfigSchema, {
            type: "mtls",
            certFile: "/etc/certs/client.crt",
            keyFile: "/etc/certs/client.key",
            caFile: "/etc/certs/ca.crt",
        });
    });

    it("rejects provider-specific fields on the wrong provider type", () => {
        expectInvalid(DbKmsConfigSchema, {
            ...validDbProvider(),
            vaultUrl: "https://vault.example.com",
        });
        expectInvalid(VaultKmsConfigSchema, {
            ...validVaultProvider(),
            region: "eu-west-1",
        });
    });

    it("rejects unknown properties", () => {
        expectInvalid(KmsConfigSchema, {
            ...validKmsConfig(),
            unexpected: true,
        });
    });

    it("rejects unknown provider and auth types", () => {
        expectInvalid(KmsProviderConfigSchema, { id: "bad", type: "unknown" });
        expectInvalid(HttpKmsAuthConfigSchema, { type: "unknown" });
    });

    it("rejects missing required HTTP auth fields", () => {
        expectInvalid(HttpAuthBearerConfigSchema, { type: "bearer" });
        expectInvalid(HttpAuthOauth2ConfigSchema, {
            type: "oauth2-client-credentials",
            tokenUrl: "https://iam.example.com/token",
        });
        expectInvalid(HttpAuthMtlsConfigSchema, {
            type: "mtls",
            certFile: "/etc/certs/client.crt",
        });
    });

    it("rejects missing required provider fields", () => {
        expectInvalid(VaultKmsConfigSchema, { id: "vault", type: "vault" });
        expectInvalid(AwsKmsConfigSchema, { id: "aws", type: "aws-kms" });
        expectInvalid(HttpKmsConfigSchema, { id: "http", type: "http" });
    });

    it("rejects empty strings for required values", () => {
        expectInvalid(DbKmsConfigSchema, { id: "", type: "db" });
        expectInvalid(VaultKmsConfigSchema, {
            id: "vault",
            type: "vault",
            vaultUrl: "",
            vaultToken: "token",
        });
        expectInvalid(HttpAuthBearerConfigSchema, {
            type: "bearer",
            token: "",
        });
    });

    it("rejects malformed URLs", () => {
        expectInvalid(VaultKmsConfigSchema, {
            ...validVaultProvider(),
            vaultUrl: "not-a-url",
        });
        expectInvalid(HttpAuthOauth2ConfigSchema, {
            type: "oauth2-client-credentials",
            tokenUrl: "not-a-url",
            clientId: "client-id",
            clientSecret: "client-secret",
        });
    });

    it("rejects duplicate provider ids", () => {
        const result = KmsConfigSchema.safeParse({
            defaultProvider: "vault",
            providers: [
                validDbProvider(),
                { ...validVaultProvider(), id: "db" },
            ],
        });

        expect(result.success).toBe(false);
        if (!result.success) {
            expect(
                result.error.issues.some(
                    (issue) => issue.path.join(".") === "providers.1.id",
                ),
            ).toBe(true);
        }
    });

    it("rejects a defaultProvider that does not match an existing provider", () => {
        const result = KmsConfigSchema.safeParse({
            defaultProvider: "missing",
            providers: [validDbProvider(), validVaultProvider()],
        });

        expect(result.success).toBe(false);
        if (!result.success) {
            expect(
                result.error.issues.some(
                    (issue) => issue.path.join(".") === "defaultProvider",
                ),
            ).toBe(true);
        }
    });

    it("accepts environment placeholders before and after expansion", () => {
        expectValid(KmsConfigSchema, {
            defaultProvider: "vault",
            providers: [
                {
                    id: "vault",
                    type: "vault",
                    vaultUrl: "${VAULT_URL}",
                    vaultToken: "${VAULT_TOKEN}",
                },
            ],
        });

        vi.stubEnv("VAULT_URL", "https://vault.example.com");
        vi.stubEnv("VAULT_TOKEN", "token");

        expect(
            parseResolvedKmsConfig(
                {
                    defaultProvider: "vault",
                    providers: [
                        {
                            id: "vault",
                            type: "vault",
                            vaultUrl: "${VAULT_URL}",
                            vaultToken: "${VAULT_TOKEN}",
                        },
                    ],
                },
                "kms.json",
                () => undefined,
            ),
        ).toMatchObject({
            providers: [
                {
                    vaultUrl: "https://vault.example.com",
                    vaultToken: "token",
                },
            ],
        });
    });

    it("rejects missing environment variables with a clear configuration error", () => {
        try {
            parseResolvedKmsConfig(
                {
                    defaultProvider: "vault",
                    providers: [
                        {
                            id: "vault",
                            type: "vault",
                            vaultUrl: "${VAULT_URL}",
                            vaultToken: "${VAULT_TOKEN}",
                        },
                    ],
                },
                "kms.json",
                () => undefined,
            );
            expect.unreachable("expected missing env vars to fail");
        } catch (error) {
            expect(error).toHaveProperty("getResponse");
            const response = (
                error as { getResponse: () => any }
            ).getResponse();
            expect(response.message).toContain("Missing environment variables");
            expect(response.errors).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        message: expect.stringContaining("VAULT_URL"),
                    }),
                ]),
            );
        }
    });

    it("never reads a refused environment variable, also inside a value", () => {
        vi.stubEnv("REFUSED_SECRET", "do-not-leak");
        vi.stubEnv("ALLOWED_URL", "https://vault.example.com");
        const refuse = (name: string) =>
            name === "REFUSED_SECRET" ? `\${${name}} is refused` : undefined;

        for (const vaultToken of ["${REFUSED_SECRET}", "x${REFUSED_SECRET}y"]) {
            try {
                parseResolvedKmsConfig(
                    {
                        providers: [
                            {
                                id: "vault",
                                type: "vault",
                                vaultUrl: "${ALLOWED_URL}",
                                vaultToken,
                            },
                        ],
                    },
                    "tenant 'a' kms.json",
                    refuse,
                );
                expect.unreachable("expected the refused variable to fail");
            } catch (error) {
                const response = (
                    error as { getResponse: () => any }
                ).getResponse();
                expect(response.message).toBe(
                    "tenant 'a' kms.json: ${REFUSED_SECRET} is refused",
                );
                expect(response.errors).toEqual([
                    expect.objectContaining({
                        code: "refused_environment_variable",
                        path: ["providers", 0, "vaultToken"],
                    }),
                ]);
                expect(JSON.stringify(response)).not.toContain("do-not-leak");
            }
        }
    });

    it("generates a standard Draft 2020-12 JSON Schema without OpenAPI discriminator keywords", () => {
        const generated = z.toJSONSchema(KmsConfigSchema, {
            target: "draft-2020-12",
        }) as Record<string, unknown>;

        assertNoDiscriminator(generated);

        const providerItems = generated.properties as
            | Record<string, any>
            | undefined;
        const oneOf = providerItems?.providers?.items?.oneOf as
            | Array<Record<string, any>>
            | undefined;
        expect(Array.isArray(oneOf)).toBe(true);
        expect(oneOf?.every((branch) => branch.properties?.type?.const)).toBe(
            true,
        );

        // allowUnionTypes: zod emits `type: [..]` arrays for unions of primitives.
        const ajv = new Ajv({ strict: true, allowUnionTypes: true });
        ajv.addFormat("uri", {
            type: "string",
            validate: (value: string) => {
                try {
                    new URL(value);
                    return true;
                } catch {
                    return false;
                }
            },
        });
        const validate = ajv.compile(generated);

        expect(validate(validKmsConfig())).toBe(true);
        expect(
            validate({
                defaultProvider: "vault",
                providers: [validDbProvider(), { id: "vault", type: "vault" }],
            }),
        ).toBe(false);
    });
});
