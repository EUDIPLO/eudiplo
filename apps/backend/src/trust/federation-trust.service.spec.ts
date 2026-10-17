import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FederationTrustService } from "./federation-trust.service.js";
import {
    type FederationResolution,
    FederationResolutionError,
} from "./ports/federation-resolver.js";
import type { FederationTrustSource } from "./types.js";

const ENTITY = "https://issuer.example.org";
const NOW = new Date("2026-10-17T12:00:00Z").getTime();

const source: FederationTrustSource = {
    mode: "federation-only",
    trustAnchors: [
        {
            entityId: "https://ta.example.org",
            entityConfigurationUri:
                "https://ta.example.org/.well-known/openid-federation",
        },
    ],
    cacheTtlSeconds: 60,
};

function resolution(expiresInMs = 60 * 60 * 1000): FederationResolution {
    return {
        entityId: ENTITY,
        trustAnchor: "https://ta.example.org",
        trustChain: ["ec", "ss", "ta"],
        metadata: {
            openid_credential_issuer: {
                jwks: {
                    keys: [
                        {
                            kid: "k1",
                            kty: "EC",
                            crv: "P-256",
                            x: "x",
                            y: "y",
                            d: "secret",
                        },
                    ],
                },
            },
            oauth_authorization_server: { issuer: ENTITY },
        },
        expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
    };
}

describe("FederationTrustService", () => {
    let resolveEntity: ReturnType<typeof vi.fn>;
    let service: FederationTrustService;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
        resolveEntity = vi.fn();
        service = new FederationTrustService({ resolveEntity });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("passes the entity, trust anchors and metadata types to the resolver", async () => {
        resolveEntity.mockResolvedValue(resolution());

        await service.resolveEntity(ENTITY, source, [
            "openid_credential_issuer",
        ]);

        expect(resolveEntity).toHaveBeenCalledWith({
            entityId: ENTITY,
            trustAnchors: [{ entityId: "https://ta.example.org" }],
            metadataTypes: ["openid_credential_issuer"],
        });
    });

    it("rejects without trust anchors", async () => {
        await expect(
            service.resolveEntity(ENTITY, { trustAnchors: [] }),
        ).rejects.toMatchObject({ failure: "untrusted" });
        expect(resolveEntity).not.toHaveBeenCalled();
    });

    it("caches a resolution for cacheTtlSeconds", async () => {
        resolveEntity.mockResolvedValue(resolution());

        await service.resolveEntity(ENTITY, source);
        vi.advanceTimersByTime(59_000);
        await service.resolveEntity(ENTITY, source);
        expect(resolveEntity).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(2_000);
        await service.resolveEntity(ENTITY, source);
        expect(resolveEntity).toHaveBeenCalledTimes(2);
    });

    it("does not cache a resolution beyond the exp of its trust chain", async () => {
        resolveEntity.mockResolvedValue(resolution(10_000));

        await service.resolveEntity(ENTITY, source);
        vi.advanceTimersByTime(11_000);
        resolveEntity.mockResolvedValue(resolution());
        await service.resolveEntity(ENTITY, source);

        expect(resolveEntity).toHaveBeenCalledTimes(2);
    });

    it("keeps resolutions for different metadata types apart", async () => {
        resolveEntity.mockResolvedValue(resolution());

        await service.resolveEntity(ENTITY, source, [
            "openid_credential_issuer",
        ]);
        await service.resolveEntity(ENTITY, source, [
            "oauth_authorization_server",
        ]);

        expect(resolveEntity).toHaveBeenCalledTimes(2);
    });

    it("applies each caller's cacheTtlSeconds to a shared resolution", async () => {
        resolveEntity.mockResolvedValue(resolution());

        await service.resolveEntity(ENTITY, {
            ...source,
            cacheTtlSeconds: 3600,
        });
        vi.advanceTimersByTime(61_000);
        await service.resolveEntity(ENTITY, source);

        expect(resolveEntity).toHaveBeenCalledTimes(2);
    });

    it("deduplicates concurrent resolutions", async () => {
        resolveEntity.mockResolvedValue(resolution());

        await Promise.all([
            service.resolveEntity(ENTITY, source),
            service.resolveEntity(ENTITY, source),
        ]);

        expect(resolveEntity).toHaveBeenCalledTimes(1);
    });

    it("never replaces a rejected chain with an earlier resolution", async () => {
        resolveEntity.mockResolvedValueOnce(resolution());
        await service.resolveEntity(ENTITY, source);
        vi.advanceTimersByTime(61_000);

        resolveEntity.mockRejectedValueOnce(
            new FederationResolutionError("signature invalid", "untrusted"),
        );
        await expect(service.resolveEntity(ENTITY, source)).rejects.toThrow(
            "signature invalid",
        );

        // A later transport failure must not bring the old resolution back
        vi.advanceTimersByTime(11_000);
        resolveEntity.mockRejectedValueOnce(
            new FederationResolutionError("timeout", "unavailable"),
        );
        await expect(service.resolveEntity(ENTITY, source)).rejects.toThrow(
            "timeout",
        );
    });

    it("reuses an earlier resolution when the federation cannot be reached, while its chain is valid", async () => {
        resolveEntity.mockResolvedValueOnce(resolution(5 * 60 * 1000));
        const first = await service.resolveEntity(ENTITY, source);
        vi.advanceTimersByTime(61_000);

        resolveEntity.mockRejectedValueOnce(
            new FederationResolutionError("timeout", "unavailable"),
        );
        await expect(service.resolveEntity(ENTITY, source)).resolves.toBe(
            first,
        );

        // After the chain's exp, the earlier resolution is not reused
        vi.advanceTimersByTime(5 * 60 * 1000);
        resolveEntity.mockRejectedValueOnce(
            new FederationResolutionError("timeout", "unavailable"),
        );
        await expect(service.resolveEntity(ENTITY, source)).rejects.toThrow(
            "timeout",
        );
    });

    it("reuses an earlier resolution for at most 15 minutes, even when its chain is valid longer", async () => {
        resolveEntity.mockResolvedValueOnce(resolution(24 * 60 * 60 * 1000));
        await service.resolveEntity(ENTITY, source);

        vi.advanceTimersByTime(16 * 60 * 1000);
        resolveEntity.mockRejectedValueOnce(
            new FederationResolutionError("timeout", "unavailable"),
        );
        await expect(service.resolveEntity(ENTITY, source)).rejects.toThrow(
            "timeout",
        );
    });

    it("does not reuse an earlier resolution after an unexpected error", async () => {
        resolveEntity.mockResolvedValueOnce(resolution());
        await service.resolveEntity(ENTITY, source);
        vi.advanceTimersByTime(61_000);

        resolveEntity.mockRejectedValueOnce(new TypeError("bug"));
        await expect(
            service.resolveEntity(ENTITY, source),
        ).rejects.toMatchObject({ failure: "untrusted", message: "bug" });
    });

    it("keeps at most 1000 cached resolutions", async () => {
        resolveEntity.mockImplementation(async ({ entityId }) => ({
            ...resolution(),
            entityId,
        }));
        for (let index = 0; index <= 1000; index++) {
            await service.resolveEntity(
                `https://issuer-${index}.example.org`,
                source,
            );
        }
        resolveEntity.mockClear();

        // The oldest entry was dropped, the newest is still cached
        await service.resolveEntity("https://issuer-1000.example.org", source);
        expect(resolveEntity).not.toHaveBeenCalled();
        await service.resolveEntity("https://issuer-0.example.org", source);
        expect(resolveEntity).toHaveBeenCalledTimes(1);
    });

    it("counts misses, resolutions, hits and stale reuses per entity", async () => {
        const add = vi.fn();
        const counted = new FederationTrustService({ resolveEntity }, {
            getCounter: vi.fn((name: string) => ({
                add: (value: number, labels: object) =>
                    add(name, value, labels),
            })),
        } as never);
        resolveEntity.mockResolvedValueOnce(resolution());
        await counted.resolveEntity(ENTITY, source);
        await counted.resolveEntity(ENTITY, source);
        vi.advanceTimersByTime(61_000);
        resolveEntity.mockRejectedValueOnce(
            new FederationResolutionError("timeout", "unavailable"),
        );
        await counted.resolveEntity(ENTITY, source);

        const labels = { entity: ENTITY };
        expect(add.mock.calls).toEqual([
            ["federation_trust_cache_misses_total", 1, labels],
            ["federation_trust_fetches_total", 1, labels],
            ["federation_trust_cache_hits_total", 1, labels],
            ["federation_trust_cache_misses_total", 1, labels],
            ["federation_trust_fetches_total", 1, labels],
            ["federation_trust_cache_stale_total", 1, labels],
        ]);
    });

    it("caches a failure for ten seconds", async () => {
        resolveEntity.mockRejectedValue(
            new FederationResolutionError("no chain", "untrusted"),
        );

        await expect(service.resolveEntity(ENTITY, source)).rejects.toThrow();
        await expect(service.resolveEntity(ENTITY, source)).rejects.toThrow();
        expect(resolveEntity).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(11_000);
        await expect(service.resolveEntity(ENTITY, source)).rejects.toThrow();
        expect(resolveEntity).toHaveBeenCalledTimes(2);
    });

    describe("resolveCredentialIssuerKey", () => {
        it("returns the public key kid of the openid_credential_issuer metadata", async () => {
            resolveEntity.mockResolvedValue(resolution());

            const { jwk } = await service.resolveCredentialIssuerKey(
                ENTITY,
                "k1",
                source,
            );

            expect(jwk).toEqual({
                kid: "k1",
                kty: "EC",
                crv: "P-256",
                x: "x",
                y: "y",
            });
            expect(resolveEntity).toHaveBeenCalledWith(
                expect.objectContaining({
                    metadataTypes: ["openid_credential_issuer"],
                }),
            );
        });

        it("rejects an unknown kid", async () => {
            resolveEntity.mockResolvedValue(resolution());

            await expect(
                service.resolveCredentialIssuerKey(ENTITY, "unknown", source),
            ).rejects.toMatchObject({
                failure: "untrusted",
                message: expect.stringContaining("has no key 'unknown'"),
            });
        });
    });

    describe("evaluateAuthorizationServerTrust", () => {
        it("requires oauth_authorization_server or openid_provider metadata in a valid chain", async () => {
            resolveEntity.mockResolvedValue(resolution());

            await expect(
                service.evaluateAuthorizationServerTrust(ENTITY, source),
            ).resolves.toMatchObject({ trusted: true });
            expect(resolveEntity).toHaveBeenCalledWith(
                expect.objectContaining({
                    metadataTypes: [
                        "oauth_authorization_server",
                        "openid_provider",
                    ],
                }),
            );
        });

        it("rejects authorization server metadata whose issuer is another entity", async () => {
            resolveEntity.mockResolvedValue({
                ...resolution(),
                metadata: {
                    oauth_authorization_server: {
                        issuer: "https://other.example.org",
                    },
                },
            });

            await expect(
                service.evaluateAuthorizationServerTrust(ENTITY, source),
            ).resolves.toMatchObject({
                trusted: false,
                reason: expect.stringContaining(
                    "is missing or not its entity identifier",
                ),
            });
        });

        it("rejects authorization server metadata without issuer", async () => {
            resolveEntity.mockResolvedValue({
                ...resolution(),
                metadata: { openid_provider: {} },
            });

            await expect(
                service.evaluateAuthorizationServerTrust(ENTITY, source),
            ).resolves.toMatchObject({ trusted: false });
        });

        it("reports why an authorization server is not trusted", async () => {
            resolveEntity.mockRejectedValue(
                new FederationResolutionError(
                    "no valid trust chain",
                    "untrusted",
                ),
            );

            await expect(
                service.evaluateAuthorizationServerTrust(ENTITY, source),
            ).resolves.toEqual({
                trusted: false,
                reason: "no valid trust chain",
            });
        });

        it("does not check federation in lote-only mode", async () => {
            await expect(
                service.evaluateAuthorizationServerTrust(ENTITY, {
                    ...source,
                    mode: "lote-only",
                }),
            ).resolves.toMatchObject({ trusted: true });
            expect(resolveEntity).not.toHaveBeenCalled();
        });
    });
});
