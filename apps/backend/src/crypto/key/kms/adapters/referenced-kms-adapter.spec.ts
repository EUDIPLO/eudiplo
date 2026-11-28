import { Logger } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { envSource } from "../../../../../test/secrets/secret-test-sources.js";
import { SecretPolicy } from "../../../../platform/secrets/application/secret-policy.js";
import { SecretReferences } from "../../../../platform/secrets/application/secret-references.js";
import {
    DEFAULT_SECRET_RESOLVER_OPTIONS,
    SecretResolver,
} from "../../../../platform/secrets/application/secret-resolver.js";
import {
    SecretReferenceInvalidError,
    SecretUnavailableError,
} from "../../../../platform/secrets/domain/secret-errors.js";
import type { KmsProviderConfig } from "../../schemas/kms-config.schema.js";
import type { KmsAdapter } from "../kms-adapter.js";
import { KmsCredentialError } from "../kms-credential-error.js";
import { kmsCredentialUse } from "../kms-credential-references.js";
import { ReferencedKmsAdapter } from "./referenced-kms-adapter.js";

const reference = "${env:ACME_VAULT_TOKEN}";
const provider = {
    id: "acme-vault",
    type: "vault",
    vaultUrl: "https://vault.example",
    vaultToken: reference,
} as unknown as KmsProviderConfig;

function setup(
    grants: string[] = ["ACME_*"],
    hideReasons = false,
    failBuild = false,
) {
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
        if (failBuild && built.length > 0)
            throw new Error("the adapter does not start");
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
        hideReasons,
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

    it("builds one adapter for concurrent operations", async () => {
        const { sign, built, retired } = setup();
        expect(await Promise.all([sign(), sign(), sign()])).toEqual([
            "first",
            "first",
            "first",
        ]);
        expect(built.map((entry) => entry.token)).toEqual([reference, "first"]);
        expect(retired).toEqual([]);
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
        const error = await sign().catch((e: unknown) => e);
        // The error names the provider only; its cause has the reason.
        expect(error).toBeInstanceOf(KmsCredentialError);
        expect(error).toMatchObject({
            providerId: "acme-vault",
            kind: "refused",
        });
        expect((error as Error).message).not.toContain(reference);
        expect(((error as Error).cause as Error).message).toMatch(/refused/);
        await expect(adapter.health()).resolves.toMatchObject({
            ok: false,
            error: expect.stringMatching(/refused/),
        });
        expect(built).toHaveLength(1);
    });

    it("reports a missing value as refused and a silent source as unavailable", async () => {
        const missing = setup();
        delete missing.environment.ACME_VAULT_TOKEN;
        await expect(missing.sign()).rejects.toMatchObject({ kind: "refused" });

        const { adapter } = setup();
        vi.spyOn(
            (adapter as unknown as { secrets: { valueOf: () => unknown } })
                .secrets,
            "valueOf",
        ).mockRejectedValue(new SecretUnavailableError(reference));
        await expect(
            adapter.sign({ publicJwk: {}, alg: "ES256" }, new Uint8Array()),
        ).rejects.toMatchObject({ kind: "unavailable" });
    });

    it("reports a malformed reference as refused and passes other errors on", async () => {
        const { adapter } = setup();
        const valueOf = vi.spyOn(
            (adapter as unknown as { secrets: { valueOf: () => unknown } })
                .secrets,
            "valueOf",
        );
        const sign = () =>
            adapter.sign({ publicJwk: {}, alg: "ES256" }, new Uint8Array());
        valueOf.mockRejectedValueOnce(
            new SecretReferenceInvalidError("the source is no source"),
        );
        await expect(sign()).rejects.toMatchObject({ kind: "refused" });
        const other = new Error("not a secret error");
        valueOf.mockRejectedValueOnce(other);
        await expect(sign()).rejects.toBe(other);
    });

    it("reports a failure that is no credential error in health, logged for a global provider", async () => {
        const warn = vi
            .spyOn(Logger.prototype, "warn")
            .mockImplementation(() => undefined);
        try {
            const own = setup(undefined, false, true);
            await expect(own.adapter.health()).resolves.toEqual({
                ok: false,
                error: "the adapter does not start",
            });
            const global = setup(undefined, true, true);
            await expect(global.adapter.health()).resolves.toEqual({
                ok: false,
                error: "the credentials of this provider cannot be read",
            });
            expect(warn).toHaveBeenCalledWith(
                expect.stringContaining("the adapter does not start"),
            );
        } finally {
            warn.mockRestore();
        }
    });

    it("tells only that the credentials cannot be read for a global provider", async () => {
        const { adapter, sign } = setup(["OTHER_*"], true);
        // Neither the kind of failure nor its reason, also in the error.
        await expect(sign()).rejects.toMatchObject({
            kind: "unavailable",
            message: expect.stringMatching(
                /cannot be read\. The operator's log/,
            ),
        });
        const health = await adapter.health();
        expect(health).toEqual({
            ok: false,
            error: "the credentials of this provider cannot be read",
        });
    });

    it("disposes the current adapter", async () => {
        const { adapter, sign, built } = setup();
        await sign();
        await adapter.dispose();
        expect(built[1].adapter.dispose).toHaveBeenCalled();
    });
});
