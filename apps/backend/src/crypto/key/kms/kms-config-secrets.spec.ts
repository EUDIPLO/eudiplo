import { describe, expect, it } from "vitest";
import {
    KMS_SECRET_PATHS,
    type KmsConfig,
} from "../schemas/kms-config.schema.js";
import {
    assertNoNewKmsInstanceCredentials,
    assertNoNewKmsPlaceholders,
    assertNoNewKmsServerFiles,
    KMS_REDACTED_SECRET,
    KmsInstanceCredentialsRefusedError,
    KmsPlaceholderRefusedError,
    KmsSecretDestinationChangedError,
    KmsSecretNotStoredError,
    KmsServerFileRefusedError,
    redactKmsConfig,
    restoreKmsSecrets,
} from "./kms-config-secrets.js";

/** One provider of every type, every credential field set. */
const config: KmsConfig = {
    defaultProvider: "vault",
    providers: [
        { id: "db", type: "db" },
        {
            id: "vault",
            type: "vault",
            vaultUrl: "https://vault.example.com",
            vaultToken: "vault-token",
        },
        {
            id: "aws",
            type: "aws-kms",
            region: "eu-central-1",
            accessKeyId: "AKIA",
            secretAccessKey: "aws-secret",
        },
        {
            id: "hsm",
            type: "pkcs11",
            library: "/usr/lib/softhsm.so",
            slot: 0,
            pin: "1234",
        },
        {
            id: "remote-bearer",
            type: "http",
            baseUrl: "https://kms.example.com",
            auth: { type: "bearer", token: "bearer-token" },
        },
        {
            id: "remote-oauth",
            type: "http",
            baseUrl: "https://kms.example.com",
            auth: {
                type: "oauth2-client-credentials",
                tokenUrl: "https://idp.example.com/token",
                clientId: "eudiplo",
                clientSecret: "oauth-secret",
            },
        },
        {
            id: "remote-mtls",
            type: "http",
            baseUrl: "https://kms.example.com",
            auth: {
                type: "mtls",
                certFile: "/certs/client.crt",
                keyFile: "/certs/client.key",
            },
        },
        {
            id: "csc",
            type: "csc",
            baseUrl: "https://csc.example.com",
            tokenUrl: "https://csc.example.com/token",
            clientId: "eudiplo",
            clientSecret: "csc-secret",
            sad: "static-sad",
            authorizeAuthData: [{ id: "PIN", value: "4321" }],
        },
    ],
};

const SECRET_VALUES = [
    "vault-token",
    "aws-secret",
    "1234",
    "bearer-token",
    "oauth-secret",
    "csc-secret",
    "static-sad",
    "4321",
];

describe("KMS configuration secrets", () => {
    it("derives the credential fields from the schema", () => {
        expect([...KMS_SECRET_PATHS].sort()).toEqual(
            [
                "providers.*.auth.clientSecret",
                "providers.*.auth.token",
                "providers.*.authorizeAuthData.*.value",
                "providers.*.clientSecret",
                "providers.*.pin",
                "providers.*.sad",
                "providers.*.secretAccessKey",
                "providers.*.vaultToken",
            ].sort(),
        );
    });

    it("redacts every credential and keeps the other settings", () => {
        const redacted = redactKmsConfig(config, {
            keepEnvPlaceholders: false,
        });

        const json = JSON.stringify(redacted);
        for (const secret of SECRET_VALUES) expect(json).not.toContain(secret);
        expect(redacted.providers[1]).toEqual({
            id: "vault",
            type: "vault",
            vaultUrl: "https://vault.example.com",
            vaultToken: KMS_REDACTED_SECRET,
        });
        expect(redacted.providers[6]).toEqual(config.providers[6]);
        expect(redacted.providers[2]).toMatchObject({ accessKeyId: "AKIA" });
    });

    it("keeps environment placeholders only when asked to", () => {
        const stored: KmsConfig = {
            providers: [
                {
                    id: "vault",
                    type: "vault",
                    vaultUrl: "${VAULT_URL}",
                    vaultToken: "${VAULT_TOKEN}",
                },
            ],
        };

        expect(
            redactKmsConfig(stored, { keepEnvPlaceholders: true }).providers[0],
        ).toMatchObject({ vaultToken: "${VAULT_TOKEN}" });
        expect(
            redactKmsConfig(stored, { keepEnvPlaceholders: false })
                .providers[0],
        ).toMatchObject({ vaultToken: KMS_REDACTED_SECRET });
    });

    it("restores redacted credentials from the stored configuration", () => {
        const update = redactKmsConfig(config, { keepEnvPlaceholders: false });

        expect(restoreKmsSecrets(update, config)).toEqual(config);
    });

    it("replaces credentials that are sent with a new value", () => {
        const update = redactKmsConfig(config, { keepEnvPlaceholders: false });
        (update.providers[1] as { vaultToken: string }).vaultToken =
            "${NEW_VAULT_TOKEN}";

        expect(restoreKmsSecrets(update, config).providers[1]).toMatchObject({
            vaultToken: "${NEW_VAULT_TOKEN}",
        });
    });

    it("rejects a redacted credential without a stored value", () => {
        const update: KmsConfig = {
            providers: [
                {
                    id: "vault",
                    type: "vault",
                    vaultUrl: "https://vault.example.com",
                    vaultToken: KMS_REDACTED_SECRET,
                },
            ],
        };

        expect(() => restoreKmsSecrets(update, null)).toThrow(
            KmsSecretNotStoredError,
        );
        // A stored provider of another type does not supply the value.
        expect(() =>
            restoreKmsSecrets(update, {
                providers: [
                    {
                        id: "vault",
                        type: "aws-kms",
                        region: "eu-central-1",
                        secretAccessKey: "aws-secret",
                    },
                ],
            }),
        ).toThrow(/providers\[0\] \('vault'\)\.vaultToken/);
    });

    describe("a kept credential follows its destination", () => {
        /** The redacted configuration with one setting of provider `id` changed. */
        function moved(id: string, change: (provider: any) => void) {
            const update = redactKmsConfig(config, {
                keepEnvPlaceholders: false,
            });
            change(update.providers.find((provider) => provider.id === id));
            return update;
        }

        it.each([
            [
                "vault",
                "vaultUrl",
                (p: any) => (p.vaultUrl = "https://evil.example"),
            ],
            ["hsm", "library", (p: any) => (p.library = "/tmp/evil.so")],
            [
                "remote-bearer",
                "baseUrl",
                (p: any) => (p.baseUrl = "https://evil.example"),
            ],
            [
                "remote-oauth",
                "auth.tokenUrl",
                (p: any) => (p.auth.tokenUrl = "https://evil.example/token"),
            ],
            [
                "csc",
                "tokenUrl",
                (p: any) => (p.tokenUrl = "https://evil.example/token"),
            ],
            [
                "csc",
                "baseUrl",
                (p: any) => (p.baseUrl = "https://evil.example"),
            ],
        ])(
            "rejects keeping the credential of %s when %s changes",
            (id, destination, change) => {
                expect(() =>
                    restoreKmsSecrets(moved(id, change), config),
                ).toThrow(KmsSecretDestinationChangedError);
                expect(() =>
                    restoreKmsSecrets(moved(id, change), config),
                ).toThrow(`but ${destination} changes`);
            },
        );

        it("accepts a new destination together with a new credential", () => {
            const update = moved("vault", (p) => {
                p.vaultUrl = "https://vault-2.example.com";
                p.vaultToken = "new-token";
            });

            expect(
                restoreKmsSecrets(update, config).providers.find(
                    (provider) => provider.id === "vault",
                ),
            ).toMatchObject({
                vaultUrl: "https://vault-2.example.com",
                vaultToken: "new-token",
            });
        });

        it("keeps credentials whose destination is unchanged or that are never sent", () => {
            // The bearer token goes to baseUrl only; another health path is fine.
            const update = moved(
                "remote-bearer",
                (p) => (p.healthPath = "/ready"),
            );
            // The AWS secret key only signs requests to AWS.
            const aws = update.providers.find(
                (provider) => provider.id === "aws",
            ) as { region: string };
            aws.region = "eu-west-1";

            expect(restoreKmsSecrets(update, config).providers).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        id: "remote-bearer",
                        auth: { type: "bearer", token: "bearer-token" },
                    }),
                    expect.objectContaining({
                        id: "aws",
                        secretAccessKey: "aws-secret",
                    }),
                ]),
            );
        });
    });
    describe("placeholders in an update", () => {
        const withProvider = (
            id: string,
            change: Record<string, unknown>,
            base: KmsConfig = config,
        ): KmsConfig => ({
            ...base,
            providers: base.providers.map((provider) =>
                provider.id === id ? { ...provider, ...change } : provider,
            ) as KmsConfig["providers"],
        });
        /** The stored file of an operator who wrote placeholders. */
        const stored = withProvider(
            "remote-bearer",
            {
                baseUrl: "${KMS_URL}",
                keysPath: "/${KMS_PREFIX}/keys",
                auth: { type: "bearer", token: "${KMS_TOKEN}" },
            },
            withProvider("vault", { vaultToken: "${VAULT_TOKEN}" }),
        );

        it("accepts an update without placeholders", () => {
            expect(() =>
                assertNoNewKmsPlaceholders(config, null),
            ).not.toThrow();
            expect(() =>
                assertNoNewKmsPlaceholders(config, stored),
            ).not.toThrow();
        });

        it.each([
            ["a credential", "vault", { vaultToken: "${MASTER_SECRET}" }],
            ["a part of a value", "vault", { vaultToken: "x${MASTER_SECRET}" }],
            [
                "a URL",
                "vault",
                { vaultUrl: "https://a.example/${DB_PASSWORD}" },
            ],
            ["a description", "vault", { description: "${MASTER_SECRET}" }],
            [
                "the default form",
                "vault",
                { description: "${MASTER_SECRET:fallback}" },
            ],
            [
                "a nested credential",
                "csc",
                {
                    authorizeAuthData: [
                        { id: "PIN", value: "${MASTER_SECRET}" },
                    ],
                },
            ],
        ])("refuses a new placeholder in %s", (_, id, change) => {
            for (const before of [null, config, stored]) {
                expect(() =>
                    assertNoNewKmsPlaceholders(
                        withProvider(id, change),
                        before,
                    ),
                ).toThrow(KmsPlaceholderRefusedError);
            }
        });

        it("refuses a new placeholder outside the providers", () => {
            expect(() =>
                assertNoNewKmsPlaceholders(
                    { ...config, defaultProvider: "${MASTER_SECRET}" },
                    config,
                ),
            ).toThrow(/defaultProvider holds a \$\{VAR\} placeholder/);
        });

        it("keeps a stored placeholder outside the providers", () => {
            const update = { ...config, defaultProvider: "${DEFAULT_KMS}" };
            expect(() =>
                assertNoNewKmsPlaceholders(update, update),
            ).not.toThrow();
        });

        it("does not keep a placeholder for a provider of another type", () => {
            const before: KmsConfig = {
                providers: [
                    {
                        id: "kms",
                        type: "vault",
                        vaultUrl: "https://vault.example.com",
                        vaultToken: "${KMS_TOKEN}",
                        description: "${KMS_TOKEN}",
                    },
                ],
            };
            expect(() =>
                assertNoNewKmsPlaceholders(
                    {
                        providers: [
                            {
                                id: "kms",
                                type: "http",
                                baseUrl: "https://attacker.example.com",
                                description: "${KMS_TOKEN}",
                            },
                        ],
                    },
                    before,
                ),
            ).toThrow(KmsPlaceholderRefusedError);
        });

        it("keeps the placeholders the stored configuration holds", () => {
            expect(() =>
                assertNoNewKmsPlaceholders(stored, stored),
            ).not.toThrow();
            // Other settings of the provider may change.
            expect(() =>
                assertNoNewKmsPlaceholders(
                    withProvider("vault", { description: "new" }, stored),
                    stored,
                ),
            ).not.toThrow();
        });

        it("does not move a stored placeholder to another field, provider or type", () => {
            expect(() =>
                assertNoNewKmsPlaceholders(
                    withProvider(
                        "vault",
                        { description: "${VAULT_TOKEN}" },
                        stored,
                    ),
                    stored,
                ),
            ).toThrow(/providers\[1\] \('vault'\)\.description/);
            expect(() =>
                assertNoNewKmsPlaceholders(
                    withProvider(
                        "remote-oauth",
                        { auth: { type: "bearer", token: "${KMS_TOKEN}" } },
                        stored,
                    ),
                    stored,
                ),
            ).toThrow(KmsPlaceholderRefusedError);
            expect(() =>
                assertNoNewKmsPlaceholders(
                    withProvider("vault", { id: "renamed" }, stored),
                    stored,
                ),
            ).toThrow(KmsPlaceholderRefusedError);
        });

        it("does not send a stored placeholder to a new address", () => {
            expect(() =>
                assertNoNewKmsPlaceholders(
                    withProvider(
                        "vault",
                        { vaultUrl: "https://attacker.example.com" },
                        stored,
                    ),
                    stored,
                ),
            ).toThrow(/vaultToken keeps a stored .* but vaultUrl changes/);
            // Also for a placeholder in a setting that is no credential.
            expect(() =>
                assertNoNewKmsPlaceholders(
                    withProvider(
                        "remote-bearer",
                        {
                            baseUrl: "https://attacker.example.com",
                            keysPath: "/${KMS_PREFIX}/keys",
                            auth: { type: "bearer", token: "new-token" },
                        },
                        stored,
                    ),
                    stored,
                ),
            ).toThrow(/keysPath keeps a stored .* but baseUrl changes/);
        });
    });

    describe("files of the backend's host in an update", () => {
        const mtls = (
            id: string,
            auth: Record<string, string>,
            baseUrl = "https://signer.example.com",
        ) =>
            ({
                id,
                type: "http",
                baseUrl,
                auth: { type: "mtls", ...auth },
            }) as KmsConfig["providers"][number];
        const hsm = (id: string, library: string) =>
            ({
                id,
                type: "pkcs11",
                library,
                slot: 0,
                pin: "1234",
            }) as KmsConfig["providers"][number];
        const FILES = { certFile: "/certs/a.crt", keyFile: "/certs/a.key" };
        const stored: KmsConfig = {
            providers: [mtls("signer", FILES), hsm("hsm", "/lib/hsm.so")],
        };
        const update =
            (...providers: KmsConfig["providers"]) =>
            () =>
                assertNoNewKmsServerFiles({ providers }, stored);

        it("accepts an update without files, and the stored files unchanged", () => {
            expect(
                update({
                    id: "db",
                    type: "db",
                } as KmsConfig["providers"][number]),
            ).not.toThrow();
            expect(update(...stored.providers)).not.toThrow();
            expect(() => assertNoNewKmsServerFiles(stored, null)).toThrow(
                KmsServerFileRefusedError,
            );
        });

        it("does not move a stored file to another setting, provider or type", () => {
            for (const refused of [
                update(mtls("other", FILES)),
                update(mtls("hsm", FILES)),
                update(hsm("signer", "/lib/hsm.so")),
                update(hsm("hsm", "/certs/a.key")),
                update(
                    mtls("signer", {
                        certFile: "/certs/a.key",
                        keyFile: "/certs/a.crt",
                    }),
                ),
                // A CA file the stored provider does not have.
                update(mtls("signer", { ...FILES, caFile: "/certs/a.crt" })),
            ]) {
                expect(refused).toThrow(KmsServerFileRefusedError);
            }
        });

        it("does not present a stored client certificate to another server", () => {
            expect(
                update(mtls("signer", FILES, "https://attacker.example.com")),
            ).toThrow(/baseUrl changes/);
        });

        it("lets an update drop a stored CA file", () => {
            const withCa: KmsConfig = {
                providers: [
                    mtls("signer", { ...FILES, caFile: "/certs/ca.crt" }),
                ],
            };
            expect(() =>
                assertNoNewKmsServerFiles(
                    { providers: [mtls("signer", FILES)] },
                    withCa,
                ),
            ).not.toThrow();
        });
    });

    describe("aws-kms providers without credentials in an update", () => {
        const aws = (id: string, region: string, credentials = {}) =>
            ({
                id,
                type: "aws-kms",
                region,
                ...credentials,
            }) as KmsConfig["providers"][number];
        const KEYS = { accessKeyId: "AKIA", secretAccessKey: "secret" };
        const stored: KmsConfig = {
            providers: [aws("role", "eu-1"), aws("keys", "eu-1", KEYS)],
        };
        const update =
            (...providers: KmsConfig["providers"]) =>
            () =>
                assertNoNewKmsInstanceCredentials({ providers }, stored);

        it("accepts providers with credentials and the stored one unchanged", () => {
            expect(update(...stored.providers)).not.toThrow();
            expect(update(aws("new", "us-1", KEYS))).not.toThrow();
        });

        it("refuses a new one, another region, and dropping stored credentials", () => {
            for (const refused of [
                update(aws("new", "eu-1")),
                update(aws("role", "us-1")),
                update(aws("keys", "eu-1")),
                update(aws("keys", "eu-1", { accessKeyId: "AKIA" })),
                () =>
                    assertNoNewKmsInstanceCredentials(
                        { providers: [aws("role", "eu-1")] },
                        null,
                    ),
            ]) {
                expect(refused).toThrow(KmsInstanceCredentialsRefusedError);
            }
        });
    });
});
