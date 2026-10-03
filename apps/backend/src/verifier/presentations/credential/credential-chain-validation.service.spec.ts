import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrustListSource } from "../../../trust/types.js";
import { FederationTrustService } from "../../../trust/federation-trust.service.js";
import { CredentialChainValidationService } from "./credential-chain-validation.service.js";

/**
 * Regression tests for the trust-list fail-open bug.
 *
 * `getTrustStoreIfConfigured` used to swallow every load error (and stale-list
 * case) and return `null`, which `validateChain` treated identically to "no
 * trust list configured" — returning `verified: true`. A verifier that had
 * configured a LoTE trust list would then silently accept ANY credential
 * whenever the list was unreachable, unparseable, or stale. Verification must
 * instead fail closed.
 */
describe("CredentialChainValidationService — trust list availability", () => {
    const LOTE_SOURCE: TrustListSource = {
        lotes: [{ url: "https://trust.example/lote.jwt" }],
    } as TrustListSource;

    let trustStore: { getTrustStore: ReturnType<typeof vi.fn> };
    let federationTrustService: Record<string, ReturnType<typeof vi.fn>>;
    let x509v: Record<string, ReturnType<typeof vi.fn>>;
    let service: CredentialChainValidationService;

    beforeEach(() => {
        trustStore = { getTrustStore: vi.fn() };
        // Plain LoTE mode: no federation, use LoTE, hybrid without enforced
        // signing policy → enforceFederationPolicy = false (the vulnerable path).
        federationTrustService = {
            shouldUseFederation: vi.fn().mockReturnValue(false),
            shouldUseLote: vi.fn().mockReturnValue(true),
            getMode: vi.fn().mockReturnValue("hybrid"),
            isEnabled: vi.fn().mockReturnValue(false),
            evaluateCertificateEntityTrust: vi.fn(),
        };
        x509v = {
            parseX5c: vi.fn().mockReturnValue([{ subject: "leaf" }]),
        };
        const logger = {
            setContext: vi.fn(),
            error: vi.fn(),
            warn: vi.fn(),
            debug: vi.fn(),
        };

        service = new CredentialChainValidationService(
            trustStore as any,
            federationTrustService as any,
            x509v as any,
            {} as any, // statusListVerifier — unused on these paths
            logger as any,
        );
    });

    it("fails closed when a configured trust list cannot be loaded", async () => {
        trustStore.getTrustStore.mockRejectedValue(
            new Error("getaddrinfo ENOTFOUND trust.example"),
        );

        const result = await service.validateChain(["<cert>"], LOTE_SOURCE, {});

        expect(result.verified).toBe(false);
        expect(result.error).toBe("trust_list_unavailable");
    });

    it("fails closed when the configured trust list is stale (NextUpdate in the past)", async () => {
        trustStore.getTrustStore.mockResolvedValue({
            entities: [],
            nextUpdate: new Date(Date.now() - 86_400_000).toISOString(),
        });

        const result = await service.validateChain(["<cert>"], LOTE_SOURCE, {});

        expect(result.verified).toBe(false);
        expect(result.error).toBe("trust_list_unavailable");
    });

    it("skips trust validation (opt-out) when no trust list is configured", async () => {
        // No lotes configured → legitimate opt-out, preserve fail-open behavior.
        const result = await service.validateChain(["<cert>"], undefined, {});

        expect(result.verified).toBe(true);
        expect(trustStore.getTrustStore).not.toHaveBeenCalled();
    });

    it("does not throw from best-effort buffer loading when the trust list is unavailable", async () => {
        trustStore.getTrustStore.mockRejectedValue(new Error("boom"));

        // Non-authoritative anchor augmentation: returns [] rather than throwing.
        await expect(
            service.getTrustedCertificateBuffers(LOTE_SOURCE),
        ).resolves.toEqual([]);
    });
});

describe("CredentialChainValidationService — OpenID Federation without a trust list", () => {
    const FEDERATION = {
        trustAnchors: [
            {
                entityId: "https://ta.example.org",
                entityConfigurationUri:
                    "https://ta.example.org/.well-known/openid-federation",
            },
        ],
    } as const;

    function serviceWith(evaluation: { trusted: boolean; reason: string }) {
        // Real mode handling, only the remote federation evaluation is faked.
        const federationTrustService = Object.assign(
            new FederationTrustService({} as never),
            {
                evaluateCertificateEntityTrust: vi
                    .fn()
                    .mockResolvedValue(evaluation),
            },
        );
        const trustStore = { getTrustStore: vi.fn() };
        const service = new CredentialChainValidationService(
            trustStore as any,
            federationTrustService,
            { parseX5c: vi.fn().mockReturnValue([{ subject: "leaf" }]) } as any,
            {} as any,
            {
                setContext: vi.fn(),
                error: vi.fn(),
                warn: vi.fn(),
                debug: vi.fn(),
            } as any,
        );
        return { service, trustStore };
    }

    it.each(["hybrid", "federation-only"] as const)(
        "rejects an issuer outside the federation in %s mode",
        async (mode) => {
            const { service, trustStore } = serviceWith({
                trusted: false,
                reason: "entity did not chain to configured trust anchor",
            });

            const result = await service.validateChain(["<cert>"], undefined, {
                federationTrustSource: {
                    ...FEDERATION,
                    mode,
                    trustAnchors: [...FEDERATION.trustAnchors],
                },
            });

            expect(result).toMatchObject({
                verified: false,
                error: "federation_trust_failed",
            });
            expect(trustStore.getTrustStore).not.toHaveBeenCalled();
        },
    );

    it.each(["hybrid", "federation-only"] as const)(
        "accepts an issuer that chains to the federation in %s mode",
        async (mode) => {
            const { service } = serviceWith({
                trusted: true,
                reason: "entity authority_hints chain to configured trust anchor",
            });

            const result = await service.validateChain(["<cert>"], undefined, {
                federationTrustSource: {
                    ...FEDERATION,
                    mode,
                    trustAnchors: [...FEDERATION.trustAnchors],
                },
            });

            expect(result.verified).toBe(true);
        },
    );
});
