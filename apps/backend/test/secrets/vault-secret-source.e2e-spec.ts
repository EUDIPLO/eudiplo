import {
    GenericContainer,
    type StartedTestContainer,
    Wait,
} from "testcontainers";
import { afterAll, beforeAll, expect, test } from "vitest";
import { VaultSecretSource } from "../../src/platform/secrets/adapters/vault-secret-source.js";
import { SecretPolicy } from "../../src/platform/secrets/application/secret-policy.js";
import {
    DEFAULT_SECRET_RESOLVER_OPTIONS,
    SecretResolver,
} from "../../src/platform/secrets/application/secret-resolver.js";
import { SecretUnavailableError } from "../../src/platform/secrets/domain/secret-errors.js";
import { describeWithContainers } from "../container-runtime.js";
import { secretSourceContract } from "./secret-source.contract.js";
import { reference } from "./secret-test-sources.js";

const ROOT_TOKEN = "test-root-token";
const MOUNTS = { secret: { version: 2 }, old: { version: 1 } } as const;

/** A Vault dev server and its address. */
async function startVault(): Promise<{
    container: StartedTestContainer;
    address: string;
}> {
    const container = await new GenericContainer("hashicorp/vault:1.19")
        .withExposedPorts(8200)
        .withEnvironment({ VAULT_DEV_ROOT_TOKEN_ID: ROOT_TOKEN })
        .withWaitStrategy(
            Wait.forHttp("/v1/sys/health", 8200).forStatusCode(200),
        )
        .start();
    return {
        container,
        address: `http://${container.getHost()}:${container.getMappedPort(8200)}`,
    };
}

describeWithContainers("Secret references — Vault source (e2e)", () => {
    let container: StartedTestContainer;
    let address: string;
    let roleId: string;
    let secretId: string;

    const vault = async (
        method: string,
        path: string,
        body?: unknown,
        token = ROOT_TOKEN,
    ) => {
        const response = await fetch(`${address}/v1/${path}`, {
            method,
            headers: {
                "X-Vault-Token": token,
                "Content-Type": "application/json",
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (!response.ok)
            throw new Error(
                `${method} ${path}: ${response.status} ${await response.text()}`,
            );
        return response.status === 204 ? {} : response.json();
    };
    const signal = () => new AbortController().signal;
    const tokenSource = (token = ROOT_TOKEN) =>
        new VaultSecretSource({
            address,
            auth: { method: "token", token },
            mounts: MOUNTS,
            // The container's address may be no loopback address.
            allowHttp: true,
        });
    const read = (source: VaultSecretSource, text: string) =>
        source.read(reference(text), signal()).then((value) => value?.reveal());

    beforeAll(async () => {
        ({ container, address } = await startVault());

        // `secret` is the dev server's KV v2 mount; `old` a KV v1 mount.
        await vault("POST", "sys/mounts/old", {
            type: "kv",
            options: { version: "1" },
        });
        await vault("POST", "secret/data/eudiplo/acme/shop", {
            data: { token: "first" },
        });
        await vault("POST", "secret/data/eudiplo/acme/shop", {
            data: { token: "second" },
        });
        await vault("POST", "secret/data/eudiplo/bob/shop", {
            data: { token: "bobs" },
        });
        await vault("POST", "old/legacy/app", { password: "legacy" });

        await vault("PUT", "sys/policies/acl/eudiplo-read", {
            policy: [
                'path "secret/data/eudiplo/acme/*" { capabilities = ["read"] }',
                'path "old/legacy/*" { capabilities = ["read"] }',
            ].join("\n"),
        });
        await vault("POST", "sys/auth/approle", { type: "approle" });
        await vault("POST", "auth/approle/role/eudiplo", {
            token_policies: ["eudiplo-read"],
            token_ttl: "1h",
        });
        roleId = (await vault("GET", "auth/approle/role/eudiplo/role-id")).data
            .role_id;
        secretId = (await vault("POST", "auth/approle/role/eudiplo/secret-id"))
            .data.secret_id;
    }, 120_000);

    afterAll(async () => {
        await container?.stop();
    });

    secretSourceContract("VaultSecretSource against Vault", () => ({
        source: tokenSource(),
        present: {
            reference: "${vault:secret/eudiplo/acme/shop#token}",
            value: "second",
        },
        missing: "${vault:secret/eudiplo/acme/none#token}",
        patterns: [
            "secret/",
            "secret/eudiplo/",
            "secret/eudiplo/acme/",
            "secret/eudiplo/acme/shop",
            "secret/eudiplo/acme/shop#token",
            "secret/eudiplo/bob/",
            "old/legacy/",
        ],
        references: [
            "${vault:secret/eudiplo/acme/shop#token}",
            "${vault:secret/eudiplo/acme/shop#other@1}",
            "${vault:secret/eudiplo/bob/shop#token}",
            "${vault:old/legacy/app#password}",
        ],
    }));

    test("reads KV v2 keys, pinned versions and KV v1 keys with a token", async () => {
        const source = tokenSource();
        expect(
            await read(source, "${vault:secret/eudiplo/acme/shop#token}"),
        ).toBe("second");
        expect(
            await read(source, "${vault:secret/eudiplo/acme/shop#token@1}"),
        ).toBe("first");
        expect(await read(source, "${vault:old/legacy/app#password}")).toBe(
            "legacy",
        );
        for (const missing of [
            "${vault:secret/eudiplo/acme/shop#none}",
            "${vault:secret/eudiplo/acme/shop#token@7}",
            "${vault:secret/eudiplo/acme/none#token}",
            "${vault:old/legacy/none#password}",
        ])
            expect(await read(source, missing), missing).toBeUndefined();
    });

    test("reads with AppRole, and answers undefined for a path its policy refuses", async () => {
        const source = new VaultSecretSource({
            address,
            auth: { method: "approle", roleId, secretId },
            mounts: MOUNTS,
            allowHttp: true,
        });
        expect(
            await read(source, "${vault:secret/eudiplo/acme/shop#token}"),
        ).toBe("second");
        expect(
            await read(source, "${vault:secret/eudiplo/bob/shop#token}"),
        ).toBeUndefined();
        expect(await read(source, "${vault:old/legacy/app#password}")).toBe(
            "legacy",
        );
    });

    test("is unavailable when Vault refuses its token", async () => {
        const created = await vault("POST", "auth/token/create", {
            policies: ["eudiplo-read"],
            ttl: "1h",
        });
        const token = created.auth.client_token as string;
        const source = tokenSource(token);
        expect(
            await read(source, "${vault:secret/eudiplo/acme/shop#token}"),
        ).toBe("second");
        // A path the token may not read is no failure of the source.
        expect(
            await read(source, "${vault:secret/eudiplo/bob/shop#token}"),
        ).toBeUndefined();
        await vault("POST", "auth/token/revoke", { token });
        await expect(
            read(source, "${vault:secret/eudiplo/acme/shop#token}"),
        ).rejects.toThrow("Vault refuses the token of this instance");
    });

    // With a Vault of its own, which it stops.
    test("resolves under the policy and picks up a rotated value after the TTL", async () => {
        const own = await startVault();
        const write = (token: string) =>
            fetch(`${own.address}/v1/secret/data/eudiplo/acme/shop`, {
                method: "POST",
                headers: { "X-Vault-Token": ROOT_TOKEN },
                body: JSON.stringify({ data: { token } }),
            }).then((response) => expect(response.ok).toBe(true));
        await write("second");
        let now = 0;
        const source = new VaultSecretSource({
            address: own.address,
            auth: { method: "token", token: ROOT_TOKEN },
            mounts: MOUNTS,
            allowHttp: true,
        });
        const resolver = new SecretResolver(
            SecretPolicy.create(
                { tenants: { "*": { vault: ["secret/eudiplo/{tenant}/"] } } },
                [source],
            ),
            {
                ...DEFAULT_SECRET_RESOLVER_OPTIONS,
                ttlMs: 1_000,
                now: () => now,
            },
        );
        const use = (tenantId: string) => ({
            scope: { type: "tenant" as const, tenantId },
            field: "WebhookEndpoint:auth.config.value",
        });
        const text = "${vault:secret/eudiplo/acme/shop#token}";
        expect((await resolver.resolve(text, use("acme"))).reveal()).toBe(
            "second",
        );
        await expect(resolver.resolve(text, use("bob"))).rejects.toThrow(
            /no grant of tenant 'bob'/,
        );
        await write("third");
        expect((await resolver.resolve(text, use("acme"))).reveal()).toBe(
            "second",
        );
        now = 1_000;
        expect((await resolver.resolve(text, use("acme"))).reveal()).toBe(
            "third",
        );
        // Vault stops: the last value serves within the stale window.
        await own.container.stop();
        now = 2_000;
        expect((await resolver.resolve(text, use("acme"))).reveal()).toBe(
            "third",
        );
        now = 2_000 + DEFAULT_SECRET_RESOLVER_OPTIONS.maxStaleMs;
        await expect(
            resolver.resolve(text, use("acme")),
        ).rejects.toBeInstanceOf(SecretUnavailableError);
    }, 60_000);
});
