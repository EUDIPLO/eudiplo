import { describe, expect, it, vi } from "vitest";
import { envSource } from "../../../../test/secrets/secret-test-sources.js";
import { SecretPolicy } from "../../../platform/secrets/application/secret-policy.js";
import { SecretReferences } from "../../../platform/secrets/application/secret-references.js";
import {
    DEFAULT_SECRET_RESOLVER_OPTIONS,
    SecretResolver,
} from "../../../platform/secrets/application/secret-resolver.js";
import type { KmsProviderConfig } from "../schemas/kms-config.schema.js";
import type { KmsAdapter } from "./kms-adapter.js";
import { kmsCredentialUse } from "./kms-credential-references.js";
import { ReferencedKmsAdapter } from "./referenced-kms-adapter.js";

const reference = "${env:ACME_VAULT_TOKEN}";
const provider = {
    id: "acme-vault",
    type: "vault",
    vaultUrl: "https://vault.example",
    vaultToken: reference,
} as unknown as KmsProviderConfig;

function setup(grants: string[] = ["ACME_*"]) {
    const environment: Record<string, string> = { ACME_VAULT_TOKEN: "first" };
    let now = 0;
    const secrets = new SecretReferences(
        new SecretResolver(
            SecretPolicy.create({ tenants: { acme: { env: grants } } }, [
                envSource(environment),
            ]),
            {
                ...DEFAULT_SECRET_RESOLVER_OPTIONS,
                ttlMs: 1_000,
                now: () => now,
            },
        ),
    );
    const built: { token: string; adapter: KmsAdapter }[] = [];
    const build = (config: KmsProviderConfig): KmsAdapter => {
        const token = (config as unknown as { vaultToken: string }).vaultToken;
        const adapter = {
            providerId: config.id,
            type: config.type,
            capabilities: {
                canCreate: true,
                canImport: false,
                canDelete: true,
                supportedAlgs: ["ES256"],
                defaultAlg: "ES256",
            },
            generateKey: vi.fn(),
            importKey: vi.fn(),
            sign: vi.fn(async () => new TextEncoder().encode(token)),
            deleteKey: vi.fn(),
            health: vi.fn(async () => ({ ok: true })),
            dispose: vi.fn(),
        } as unknown as KmsAdapter;
        built.push({ token, adapter });
        return adapter;
    };
    const retired: KmsAdapter[] = [];
    const adapter = new ReferencedKmsAdapter(
        provider,
        [{ path: ["vaultToken"], value: reference }],
        (path) =>
            kmsCredentialUse(
                { type: "tenant", tenantId: "acme" },
                0,
                provider,
                path,
            ),
        secrets,
        build,
        (old) => retired.push(old),
    );
    const sign = async () =>
        new TextDecoder().decode(
            await adapter.sign(
                { publicJwk: {}, alg: "ES256" },
                new Uint8Array(),
            ),
        );
    return {
        adapter,
        built,
        retired,
        sign,
        environment,
        advance: (ms: number) => {
            now += ms;
        },
    };
}

describe("ReferencedKmsAdapter", () => {
    it("takes what needs no credential from the unresolved provider", () => {
        const { adapter, built } = setup();
        expect(adapter.providerId).toBe("acme-vault");
        expect(adapter.capabilities.defaultAlg).toBe("ES256");
        // The probe got the reference, never a value.
        expect(built.map((entry) => entry.token)).toEqual([reference]);
    });

    it("builds the adapter from the value when used, and reuses it", async () => {
        const { sign, built } = setup();
        expect(await sign()).toBe("first");
        expect(await sign()).toBe("first");
        expect(built.map((entry) => entry.token)).toEqual([reference, "first"]);
    });

    it("rebuilds the adapter when the value rotates and retires the old one", async () => {
        const { sign, built, retired, environment, advance } = setup();
        await sign();
        environment.ACME_VAULT_TOKEN = "second";
        // Within the resolver's cache time, the old value is still used.
        expect(await sign()).toBe("first");
        advance(1_000);
        expect(await sign()).toBe("second");
        expect(built.map((entry) => entry.token)).toEqual([
            reference,
            "first",
            "second",
        ]);
        expect(retired).toEqual([built[1].adapter]);
    });

    it("fails the operation, not the provider, for a refused reference", async () => {
        const { adapter, sign, built } = setup(["OTHER_*"]);
        await expect(sign()).rejects.toThrow(/refused/);
        await expect(adapter.health()).resolves.toMatchObject({
            ok: false,
            error: expect.stringMatching(/refused/),
        });
        expect(built).toHaveLength(1);
    });

    it("disposes the current adapter", async () => {
        const { adapter, sign, built } = setup();
        await sign();
        await adapter.dispose();
        expect(built[1].adapter.dispose).toHaveBeenCalled();
    });
});
