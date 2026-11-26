import { describe, expect, it } from "vitest";
import { envSource } from "../../../../test/secrets/secret-test-sources.js";
import { SecretPolicyError } from "../domain/secret-errors.js";
import { readSecretPolicyFile } from "./secret-policy-file.js";
import { VaultSecretSource } from "./vault-secret-source.js";

const read = (
    file: unknown,
    env: Record<string, string> = {},
): ReturnType<typeof readSecretPolicyFile> =>
    readSecretPolicyFile({
        text: typeof file === "string" ? file : JSON.stringify(file),
        env,
        envSource: (variables) =>
            envSource(variables as Record<string, string>),
    });

const issues = (fn: () => unknown): string[] => {
    try {
        fn();
    } catch (error) {
        if (error instanceof SecretPolicyError) return error.issues;
        throw error;
    }
    throw new Error("expected a SecretPolicyError");
};

const vault = {
    address: "https://vault.example:8200",
    auth: { method: "token" },
    mounts: { kv: { version: 2 } },
};

describe("readSecretPolicyFile", () => {
    it("always has the env source, and the vault source when it is set", () => {
        expect(
            read({ tenants: { acme: { env: ["ACME_*"] } } }).sources.map(
                (source) => source.type,
            ),
        ).toEqual(["env"]);

        const { sources, policy } = read(
            {
                $schema: "https://eudiplo.dev/schemas/SecretPolicyFile.json",
                sources: { vault },
                tenants: { "*": { vault: ["kv/eudiplo/{tenant}/"] } },
            },
            { SECRET_VAULT_TOKEN: "root" },
        );
        expect(sources.map((source) => source.type)).toEqual(["env", "vault"]);
        expect(sources[1]).toBeInstanceOf(VaultSecretSource);
        expect(policy.source("vault")).toBe(sources[1]);
    });

    it("reads the Vault credentials from the environment only", () => {
        expect(issues(() => read({ sources: { vault } }))).toEqual([
            "sources.vault: set SECRET_VAULT_TOKEN for the token login",
        ]);
        expect(
            issues(() =>
                read(
                    {
                        sources: {
                            vault: { ...vault, auth: { method: "approle" } },
                        },
                    },
                    { SECRET_VAULT_ROLE_ID: "role" },
                ),
            ),
        ).toEqual([
            "sources.vault: set SECRET_VAULT_SECRET_ID for the approle login",
        ]);
        // A token in the file itself is refused.
        expect(
            issues(() =>
                read({
                    sources: {
                        vault: {
                            ...vault,
                            auth: { method: "token", token: "in-file" },
                        },
                    },
                }),
            ).join(),
        ).toMatch(/sources\.vault\.auth/);
    });

    it("refuses an http address of another host, without quoting the file", () => {
        const found = issues(() =>
            read(
                {
                    sources: {
                        vault: { ...vault, address: "http://vault.example" },
                    },
                },
                { SECRET_VAULT_TOKEN: "root" },
            ),
        );
        expect(found).toHaveLength(1);
        expect(found[0]).toMatch(/^sources\.vault\.address: .*http:/);
        expect(found[0]).not.toContain("root");
    });

    it("names invalid JSON and unknown fields", () => {
        expect(issues(() => read("{ not json"))).toEqual([
            "the file is no valid JSON",
        ]);
        expect(issues(() => read({ sources: { aws: {} } })).join()).toMatch(
            /^sources/,
        );
        expect(issues(() => read({ tenant: {} })).join()).toMatch(
            /Unrecognized key/,
        );
        expect(
            issues(() =>
                read({ sources: { vault: { ...vault, mounts: {} } } }),
            ),
        ).toEqual(["sources.vault.mounts: list at least one KV mount"]);
    });

    it("checks the grants against the sources it builds", () => {
        expect(
            issues(() =>
                read({ tenants: { "*": { vault: ["kv/eudiplo/{tenant}/"] } } }),
            ).join(),
        ).toMatch(/vault/);
    });
});
