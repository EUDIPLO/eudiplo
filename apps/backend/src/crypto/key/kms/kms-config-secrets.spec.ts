import { describe, expect, it } from "vitest";
import {
    KMS_SECRET_PATHS,
    type KmsConfig,
} from "../schemas/kms-config.schema.js";
import {
    KMS_REDACTED_SECRET,
    KmsSecretNotStoredError,
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
});
