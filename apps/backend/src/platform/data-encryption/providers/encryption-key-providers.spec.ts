import { randomBytes } from "node:crypto";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SecretClient } from "@azure/keyvault-secrets";
import type { HttpService } from "@nestjs/axios";
import { Logger } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import { of, throwError } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AwsSecretsManagerEncryptionKeyProvider } from "./aws-secrets-manager-encryption-key.provider.js";
import { AzureKeyVaultEncryptionKeyProvider } from "./azure-keyvault-encryption-key.provider.js";
import { EnvEncryptionKeyProvider } from "./env-encryption-key.provider.js";
import { VaultEncryptionKeyProvider } from "./vault-encryption-key.provider.js";

const KEY = randomBytes(32);

function config(values: Record<string, string | undefined>): ConfigService {
    return { get: (key: string) => values[key] } as ConfigService;
}

function errorNamed(name: string, fields: Record<string, unknown> = {}) {
    return Object.assign(new Error(name), { name, ...fields });
}

beforeEach(() => {
    vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
});

afterEach(() => vi.restoreAllMocks());

describe("EnvEncryptionKeyProvider", () => {
    it("derives the same 32-byte key from the same MASTER_SECRET", async () => {
        const provider = new EnvEncryptionKeyProvider(
            config({ MASTER_SECRET: "secret-a" }),
        );

        const key = await provider.getKey();

        expect(key).toHaveLength(32);
        expect(await provider.getKey()).toEqual(key);
    });

    it("derives another key from another MASTER_SECRET", async () => {
        const a = new EnvEncryptionKeyProvider(
            config({ MASTER_SECRET: "secret-a" }),
        );
        const b = new EnvEncryptionKeyProvider(
            config({ MASTER_SECRET: "secret-b" }),
        );

        expect(await a.getKey()).not.toEqual(await b.getKey());
    });

    it("needs MASTER_SECRET", async () => {
        await expect(
            new EnvEncryptionKeyProvider(config({})).getKey(),
        ).rejects.toThrow("MASTER_SECRET is required");
    });
});

describe("VaultEncryptionKeyProvider", () => {
    function provider(get: HttpService["get"]) {
        return new VaultEncryptionKeyProvider(
            config({
                VAULT_ADDR: "https://vault.example",
                VAULT_TOKEN: "token",
            }),
            { get } as HttpService,
        );
    }

    function answer(key: string | undefined) {
        return vi.fn(() => of({ data: { data: { data: { key } } } })) as never;
    }

    it("reads a base64 key from the default path with the token", async () => {
        const get = answer(KEY.toString("base64"));

        expect(await provider(get).getKey()).toEqual(KEY);
        expect(get).toHaveBeenCalledWith(
            "https://vault.example/v1/secret/data/eudiplo/encryption-key",
            { headers: { "X-Vault-Token": "token" } },
        );
    });

    it("reads a hex key", async () => {
        expect(await provider(answer(KEY.toString("hex"))).getKey()).toEqual(
            KEY,
        );
    });

    it("rejects a key that is not 32 bytes", async () => {
        await expect(
            provider(answer(randomBytes(16).toString("base64"))).getKey(),
        ).rejects.toThrow("expected 32 bytes, got 16");
    });

    it("rejects a secret without key", async () => {
        await expect(provider(answer(undefined)).getKey()).rejects.toThrow(
            "Encryption key not found at Vault path",
        );
    });

    it.each([
        [404, "Encryption key not found in Vault at path"],
        [403, "Access denied to Vault path"],
        [500, "Failed to fetch encryption key from Vault"],
    ])("explains HTTP %i", async (status, message) => {
        const get = vi.fn(() =>
            throwError(() =>
                Object.assign(new Error(`HTTP ${status}`), {
                    response: { status },
                }),
            ),
        ) as never;

        await expect(provider(get).getKey()).rejects.toThrow(message);
    });
});

describe("AwsSecretsManagerEncryptionKeyProvider", () => {
    const settings = {
        AWS_REGION: "eu-central-1",
        AWS_ENCRYPTION_SECRET_NAME: "eudiplo/key",
    };

    function provider(
        answer: unknown,
        values: Record<string, string> = settings,
    ) {
        const send = vi
            .spyOn(SecretsManagerClient.prototype, "send")
            .mockImplementation(() =>
                answer instanceof Error
                    ? Promise.reject(answer)
                    : Promise.resolve(answer),
            );
        return {
            provider: new AwsSecretsManagerEncryptionKeyProvider(
                config(values),
            ),
            send,
        };
    }

    it.each([
        ["AWS_REGION", { AWS_ENCRYPTION_SECRET_NAME: "eudiplo/key" }],
        ["AWS_ENCRYPTION_SECRET_NAME", { AWS_REGION: "eu-central-1" }],
    ])("needs %s", (name, values) => {
        expect(
            () => new AwsSecretsManagerEncryptionKeyProvider(config(values)),
        ).toThrow(`${name} is required`);
    });

    it("reads a plain base64 secret by its name", async () => {
        const { provider: p, send } = provider({
            SecretString: KEY.toString("base64"),
        });

        expect(await p.getKey()).toEqual(KEY);
        expect(send.mock.calls[0][0].input).toEqual({
            SecretId: "eudiplo/key",
        });
    });

    it("reads a plain hex secret", async () => {
        const { provider: p } = provider({ SecretString: KEY.toString("hex") });

        expect(await p.getKey()).toEqual(KEY);
    });

    it("reads a hex secret that JSON would read as a number", async () => {
        const digits = "1".repeat(64);
        const { provider: p } = provider({ SecretString: digits });

        expect(await p.getKey()).toEqual(Buffer.from(digits, "hex"));
    });

    it("reads the key field of a JSON secret", async () => {
        const { provider: p } = provider({
            SecretString: JSON.stringify({ key: KEY.toString("base64") }),
        });

        expect(await p.getKey()).toEqual(KEY);
    });

    it("reads the field named by AWS_ENCRYPTION_SECRET_KEY", async () => {
        const { provider: p } = provider(
            {
                SecretString: JSON.stringify({
                    dataKey: KEY.toString("base64"),
                }),
            },
            { ...settings, AWS_ENCRYPTION_SECRET_KEY: "dataKey" },
        );

        expect(await p.getKey()).toEqual(KEY);
    });

    it("names the missing field of a JSON secret", async () => {
        const { provider: p } = provider({
            SecretString: JSON.stringify({ other: KEY.toString("base64") }),
        });

        await expect(p.getKey()).rejects.toThrow(
            'Secret JSON does not contain key "key"',
        );
    });

    it("rejects a JSON secret whose field is not a string", async () => {
        const { provider: p } = provider({
            SecretString: JSON.stringify({ key: 123 }),
        });

        await expect(p.getKey()).rejects.toThrow(
            'Secret JSON does not contain key "key"',
        );
    });

    it("reads a 32-byte binary secret", async () => {
        const { provider: p } = provider({
            SecretBinary: new Uint8Array(KEY),
        });

        expect(await p.getKey()).toEqual(KEY);
    });

    it("rejects a binary secret that is not 32 bytes", async () => {
        const { provider: p } = provider({
            SecretBinary: new Uint8Array(16),
        });

        await expect(p.getKey()).rejects.toThrow("expected 32 bytes, got 16");
    });

    it("rejects a secret without value", async () => {
        const { provider: p } = provider({});

        await expect(p.getKey()).rejects.toThrow("Secret has no value");
    });

    it("rejects a key that is not 32 bytes", async () => {
        const { provider: p } = provider({
            SecretString: randomBytes(16).toString("base64"),
        });

        await expect(p.getKey()).rejects.toThrow("expected 32 bytes, got 16");
    });

    it.each([
        ["ResourceNotFoundException", "Encryption key secret not found"],
        ["AccessDeniedException", "Access denied to secret"],
        ["ThrottlingException", "Failed to fetch encryption key from AWS"],
    ])("explains %s", async (name, message) => {
        const { provider: p } = provider(errorNamed(name));

        await expect(p.getKey()).rejects.toThrow(message);
    });
});

describe("AzureKeyVaultEncryptionKeyProvider", () => {
    const settings = {
        AZURE_KEYVAULT_URL: "https://vault.vault.azure.net",
        AZURE_ENCRYPTION_SECRET_NAME: "eudiplo-key",
    };

    function provider(answer: unknown) {
        const getSecret = vi
            .spyOn(SecretClient.prototype, "getSecret")
            .mockImplementation(() =>
                answer instanceof Error
                    ? Promise.reject(answer)
                    : Promise.resolve(answer as never),
            );
        return {
            provider: new AzureKeyVaultEncryptionKeyProvider(config(settings)),
            getSecret,
        };
    }

    it.each([
        ["AZURE_KEYVAULT_URL", { AZURE_ENCRYPTION_SECRET_NAME: "eudiplo-key" }],
        [
            "AZURE_ENCRYPTION_SECRET_NAME",
            { AZURE_KEYVAULT_URL: "https://vault.vault.azure.net" },
        ],
    ])("needs %s", (name, values) => {
        expect(
            () => new AzureKeyVaultEncryptionKeyProvider(config(values)),
        ).toThrow(`${name} is required`);
    });

    it("reads a base64 secret by its name", async () => {
        const { provider: p, getSecret } = provider({
            value: KEY.toString("base64"),
        });

        expect(await p.getKey()).toEqual(KEY);
        expect(getSecret).toHaveBeenCalledWith("eudiplo-key");
    });

    it("reads a hex secret", async () => {
        const { provider: p } = provider({ value: KEY.toString("hex") });

        expect(await p.getKey()).toEqual(KEY);
    });

    it("rejects a secret without value", async () => {
        const { provider: p } = provider({});

        await expect(p.getKey()).rejects.toThrow("has no value");
    });

    it("rejects a key that is not 32 bytes", async () => {
        const { provider: p } = provider({
            value: randomBytes(16).toString("base64"),
        });

        await expect(p.getKey()).rejects.toThrow("expected 32 bytes, got 16");
    });

    it.each([
        [{ code: "SecretNotFound" }, "Encryption key secret not found"],
        [{ code: "Forbidden" }, "Access denied to secret"],
        [{ statusCode: 403 }, "Access denied to secret"],
        [
            { code: "ServiceUnavailable" },
            "Failed to fetch encryption key from Azure",
        ],
    ])("explains %o", async (fields, message) => {
        const { provider: p } = provider(errorNamed("RestError", fields));

        await expect(p.getKey()).rejects.toThrow(message);
    });
});
