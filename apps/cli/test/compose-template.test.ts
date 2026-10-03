import { describe, expect, it } from "vitest";
import {
    createComposeEnv,
    createGlobalKmsConfig,
    resolveImageTag,
} from "../src/services/compose-project.js";

describe("compose template helpers", () => {
    it("uses latest image tags by default", () => {
        const env = createComposeEnv({ mode: "demo" });

        expect(env).toContain(
            "EUDIPLO_IMAGE=ghcr.io/openwallet-foundation/eudiplo:latest",
        );
        expect(env).toContain(
            "EUDIPLO_CLIENT_IMAGE=ghcr.io/openwallet-foundation/eudiplo-client:latest",
        );
    });

    it("keeps demo mode minimal regardless of optional component inputs", () => {
        const env = createComposeEnv({
            mode: "demo",
            database: "postgres",
            storage: "s3",
            kms: "vault",
        });

        expect(env).toContain("DB_TYPE=sqlite");
        expect(env).toContain("STORAGE_DRIVER=local");
        expect(env).toContain("EUDIPLO_CONFIG_MOUNT=./config:/app/config");
        expect(env).toContain("CONFIG_FOLDER=/app/config");
        expect(env).not.toContain("DB_HOST=postgres");
        expect(env).not.toContain("S3_ENDPOINT=");
        expect(env).not.toContain("VAULT_ADDR=");
        expect(env).not.toContain("KM_TYPE");
        expect(env.endsWith("\n\n")).toBe(false);
    });

    it("generates a global db KMS configuration", () => {
        const config = JSON.parse(createGlobalKmsConfig("db"));

        expect(config.defaultProvider).toBe("db");
        expect(config.providers).toEqual([
            {
                id: "db",
                type: "db",
                description: "Database-backed key provider",
            },
        ]);
    });

    it("keeps db available when Vault is the default KMS provider", () => {
        const config = JSON.parse(createGlobalKmsConfig("vault"));

        expect(config.defaultProvider).toBe("vault");
        expect(
            config.providers.map((provider: { id: string }) => provider.id),
        ).toEqual(["db", "vault"]);
        expect(config.providers[1].vaultUrl).toBe("${VAULT_ADDR}");
        expect(config.providers[1].vaultToken).toBe("${VAULT_TOKEN}");
    });

    it("generates environment variables for selected compose components", () => {
        const env = createComposeEnv({
            mode: "standard",
            database: "postgres",
            storage: "s3",
            kms: "vault",
            publicUrl: "https://eudiplo.example.com",
            authClientId: "example-client",
            authClientSecret: "example-secret",
        });

        expect(env).toContain("PUBLIC_URL=https://eudiplo.example.com");
        expect(env).toContain("AUTH_CLIENT_ID=example-client");
        expect(env).toContain("AUTH_CLIENT_SECRET=example-secret");
        expect(env).toContain(
            "EUDIPLO_IMAGE=ghcr.io/openwallet-foundation/eudiplo:latest",
        );
        expect(env).toContain(
            "EUDIPLO_CLIENT_IMAGE=ghcr.io/openwallet-foundation/eudiplo-client:latest",
        );
        expect(env).toContain("DB_TYPE=postgres");
        expect(env).toContain("DB_HOST=postgres");
        expect(env).toContain("STORAGE_DRIVER=s3");
        expect(env).toContain("S3_ENDPOINT=http://rustfs:9000");
        const variables = Object.fromEntries(
            env.split("\n").map((line) => line.split("=", 2)),
        );
        expect(variables.RUSTFS_ACCESS_KEY).toBe(variables.S3_ACCESS_KEY_ID);
        expect(variables.RUSTFS_SECRET_KEY).toBeTruthy();
        expect(variables.RUSTFS_SECRET_KEY).toBe(
            variables.S3_SECRET_ACCESS_KEY,
        );
        expect(env).not.toContain("MINIO_");
        expect(env).not.toContain("KM_TYPE");
        expect(env).toContain("VAULT_ADDR=http://vault:8200");
        expect(env).toContain("VAULT_TOKEN=root");
    });

    it("quotes user-provided environment values without interpolating dollar signs", () => {
        const env = createComposeEnv({
            mode: "standard",
            authClientId: "client with spaces",
            authClientSecret: "secret$value",
        });

        expect(env).toContain("AUTH_CLIENT_ID='client with spaces'");
        expect(env).toContain("AUTH_CLIENT_SECRET='secret$value'");
    });

    it("resolves latest when no image tag override is supplied", () => {
        expect(resolveImageTag()).toBe("latest");
    });

    it("supports explicit image tag overrides", () => {
        expect(resolveImageTag("sha-deadbeef")).toBe("sha-deadbeef");

        const env = createComposeEnv({
            mode: "standard",
            imageTagOverride: "main",
        });
        expect(env).toContain(
            "EUDIPLO_IMAGE=ghcr.io/openwallet-foundation/eudiplo:main",
        );
        expect(env).toContain(
            "EUDIPLO_CLIENT_IMAGE=ghcr.io/openwallet-foundation/eudiplo-client:main",
        );
    });
});
