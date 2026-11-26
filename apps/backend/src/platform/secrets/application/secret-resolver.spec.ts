import { inspect } from "node:util";
import { beforeEach, describe, expect, it } from "vitest";
import {
    envSource,
    StubVaultSource,
} from "../../../../test/secrets/secret-test-sources.js";
import {
    SecretMissingError,
    SecretReferenceInvalidError,
    SecretReferenceRefusedError,
    SecretUnavailableError,
} from "../domain/secret-errors.js";
import type { SecretUse } from "../domain/secret-use.js";
import { SecretPolicy } from "./secret-policy.js";
import {
    DEFAULT_SECRET_RESOLVER_OPTIONS,
    SecretResolver,
} from "./secret-resolver.js";

const SHOP = "${vault:kv/t/acme/shop#token}";
const ref = (name: string) => `\${vault:kv/t/acme/${name}#token}`;
const use: SecretUse = {
    scope: { type: "tenant", tenantId: "acme" },
    field: "WebhookEndpoint:auth.config.value",
    destination: "https://shop.example/hook",
};

describe("SecretResolver", () => {
    let vault: StubVaultSource;
    let now: number;
    let stale: string[];
    let resolver: SecretResolver;

    const create = (
        options: { maxEntries?: number; timeoutMs?: number } = {},
    ) => {
        const sources = [envSource({ ACME_TOKEN: "env-value" }), vault];
        resolver = new SecretResolver(
            SecretPolicy.create(
                {
                    tenants: {
                        "*": { vault: ["kv/t/{tenant}/"] },
                        acme: { env: ["ACME_*"] },
                    },
                },
                sources,
            ),
            {
                ...DEFAULT_SECRET_RESOLVER_OPTIONS,
                ttlMs: 1_000,
                maxStaleMs: 10_000,
                cooldownMs: 500,
                ...options,
                now: () => now,
                onStale: (reference, cause) =>
                    stale.push(`${reference}: ${String(cause)}`),
            },
        );
    };

    beforeEach(() => {
        vault = new StubVaultSource();
        vault.values.set("kv/t/acme/shop#token", "v1");
        for (const name of ["a", "b", "c"])
            vault.values.set(`kv/t/acme/${name}#token`, name);
        now = 0;
        stale = [];
        create();
    });

    it("resolves env and vault references", async () => {
        expect(
            (await resolver.resolve("${env:ACME_TOKEN}", use)).reveal(),
        ).toBe("env-value");
        expect((await resolver.resolve(SHOP, use)).reveal()).toBe("v1");
    });

    it("refuses what the policy refuses, also once a value is cached", async () => {
        await resolver.resolve(SHOP, use);
        const other: SecretUse = {
            ...use,
            scope: { type: "tenant", tenantId: "other" },
        };
        await expect(resolver.resolve(SHOP, other)).rejects.toBeInstanceOf(
            SecretReferenceRefusedError,
        );
        await expect(resolver.resolve(SHOP, other)).rejects.toThrow(
            /^\$\{vault:kv\/t\/acme\/shop#token\} is refused: no grant of tenant 'other'/,
        );
        expect(vault.reads).toBe(1);
    });

    it("refuses values that are no valid reference", async () => {
        await expect(resolver.resolve("plain", use)).rejects.toBeInstanceOf(
            SecretReferenceInvalidError,
        );
        await expect(
            resolver.resolve("${vault:kv/app}", use),
        ).rejects.toBeInstanceOf(SecretReferenceInvalidError);
        await expect(
            resolver.resolve("${required:x}", use),
        ).rejects.toBeInstanceOf(SecretReferenceRefusedError);
        expect(resolver.check("${env:ACME_TOKEN}", use)).toMatchObject({
            source: "env",
            variable: "ACME_TOKEN",
        });
    });

    it("reads again after the TTL and picks up a rotated value", async () => {
        await resolver.resolve(SHOP, use);
        vault.values.set("kv/t/acme/shop#token", "v2");
        now = 999;
        expect((await resolver.resolve(SHOP, use)).reveal()).toBe("v1");
        now = 1_000;
        expect((await resolver.resolve(SHOP, use)).reveal()).toBe("v2");
        expect(vault.reads).toBe(2);
    });

    it("asks the source once for concurrent uses", async () => {
        const values = await Promise.all([
            resolver.resolve(SHOP, use),
            resolver.resolve(SHOP, use),
            resolver.resolve(SHOP, use),
        ]);
        expect(values.map((value) => value.reveal())).toEqual([
            "v1",
            "v1",
            "v1",
        ]);
        expect(vault.reads).toBe(1);
    });

    it("serves the last value while the source is down, within the stale window", async () => {
        await resolver.resolve(SHOP, use);
        vault.failing = "all";
        now = 1_500;
        expect((await resolver.resolve(SHOP, use)).reveal()).toBe("v1");
        // During the cooldown the source is not asked; the value still serves.
        now = 1_800;
        expect((await resolver.resolve(SHOP, use)).reveal()).toBe("v1");
        expect(vault.reads).toBe(2);
        expect(stale).toEqual([
            "${vault:kv/t/acme/shop#token}: Error: vault is down",
            "${vault:kv/t/acme/shop#token}: undefined",
        ]);
        // After TTL and stale window the use fails.
        now = 11_000;
        const failure = resolver.resolve(SHOP, use);
        await expect(failure).rejects.toBeInstanceOf(SecretUnavailableError);
        await expect(failure).rejects.toThrow(
            "${vault:kv/t/acme/shop#token} cannot be read: its source is unavailable",
        );
    });

    it("fails without a cached value while the source is down", async () => {
        vault.failing = "all";
        await expect(resolver.resolve(SHOP, use)).rejects.toBeInstanceOf(
            SecretUnavailableError,
        );
        // Not asked again during the cooldown.
        await expect(resolver.resolve(SHOP, use)).rejects.toBeInstanceOf(
            SecretUnavailableError,
        );
        expect(vault.reads).toBe(1);
        vault.failing = false;
        now = 500;
        expect((await resolver.resolve(SHOP, use)).reveal()).toBe("v1");
    });

    it("holds back only the reference whose read failed", async () => {
        await resolver.resolve(ref("b"), use);
        vault.failing = new Set(["kv/t/acme/a#token"]);
        await expect(resolver.resolve(ref("a"), use)).rejects.toBeInstanceOf(
            SecretUnavailableError,
        );
        // Other references are still read, cached or not.
        now = 1_000;
        expect((await resolver.resolve(ref("b"), use)).reveal()).toBe("b");
        expect((await resolver.resolve(ref("c"), use)).reveal()).toBe("c");
        expect(vault.reads).toBe(4);
        expect(stale).toEqual([]);
    });

    it("gives up a read after the timeout, also when the source ignores it", async () => {
        create({ timeoutMs: 20 });
        await resolver.resolve(SHOP, use);
        vault.hanging = true;
        now = 1_000;
        // Within the stale window: the last value, reported as stale.
        expect((await resolver.resolve(SHOP, use)).reveal()).toBe("v1");
        expect(stale).toEqual([
            "${vault:kv/t/acme/shop#token}: ReadTimeoutError: the source did not answer within 20 ms",
        ]);
        // The read was told to stop.
        expect(vault.lastSignal?.aborted).toBe(true);
        expect(String(vault.lastSignal?.reason)).toMatch(/ReadTimeoutError/);
        // Nothing cached: the use fails instead of waiting.
        await expect(resolver.resolve(ref("a"), use)).rejects.toBeInstanceOf(
            SecretUnavailableError,
        );
        // During the cooldown the source is not asked again.
        await expect(resolver.resolve(ref("a"), use)).rejects.toBeInstanceOf(
            SecretUnavailableError,
        );
        expect(vault.reads).toBe(3);
    });

    it("treats a read that throws instead of rejecting as a failed read", async () => {
        create({ timeoutMs: 20 });
        vault.read = () => {
            throw new Error("thrown, not rejected");
        };
        await expect(resolver.resolve(SHOP, use)).rejects.toBeInstanceOf(
            SecretUnavailableError,
        );
        // The timer was cleared: nothing rejects after the timeout.
        await new Promise((resolve) => setTimeout(resolve, 40));
    });

    it("does not serve a value the source no longer holds", async () => {
        await resolver.resolve(SHOP, use);
        vault.values.delete("kv/t/acme/shop#token");
        now = 1_000;
        await expect(resolver.resolve(SHOP, use)).rejects.toBeInstanceOf(
            SecretMissingError,
        );
        vault.failing = "all";
        now = 2_000;
        await expect(resolver.resolve(SHOP, use)).rejects.toBeInstanceOf(
            SecretUnavailableError,
        );
    });

    it("keeps at most maxEntries values, dropping the least recently used", async () => {
        create({ maxEntries: 2 });
        await resolver.resolve(ref("a"), use);
        await resolver.resolve(ref("b"), use);
        await resolver.resolve(ref("a"), use);
        await resolver.resolve(ref("c"), use);
        expect(vault.reads).toBe(3);
        await resolver.resolve(ref("a"), use);
        expect(vault.reads).toBe(3);
        await resolver.resolve(ref("b"), use);
        expect(vault.reads).toBe(4);
    });

    it("never puts a value into an error or the stale report", async () => {
        await resolver.resolve(SHOP, use);
        vault.failing = "all";
        now = 1_500;
        await resolver.resolve(SHOP, use);
        now = 20_000;
        const error = await resolver.resolve(SHOP, use).catch((e) => e);
        expect(error).toBeInstanceOf(SecretUnavailableError);
        expect(inspect(error, { depth: 10 })).not.toContain("v1");
        expect(stale).toHaveLength(1);
        expect(stale.join()).not.toContain("v1");
    });
});
