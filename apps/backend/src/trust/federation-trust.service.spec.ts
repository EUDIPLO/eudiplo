import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import {
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { FederationTrustService } from "./federation-trust.service.js";
import {
    type FederationResolution,
    FederationResolutionError,
} from "./ports/federation-resolver.js";
import type { FederationTrustSource } from "./types.js";

const ENTITY = "https://issuer.example.org";
const NOW = new Date("2026-10-17T12:00:00Z").getTime();

const TA = "https://ta.example.org";

const source: FederationTrustSource = {
    tenantId: "tenant",
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
        trustChain: ["ec", "ss", taEntityConfiguration],
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

/** The trust anchor's pinned public key and its signed entity configuration. */
let taJwk: JWK;
let taEntityConfiguration: string;

async function entityConfiguration(sub: string, kid = "ta-1") {
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    const jwt = await new SignJWT({ iss: sub, sub })
        .setProtectedHeader({ alg: "ES256", kid, typ: "entity-statement+jwt" })
        .sign(privateKey);
    return { jwt, jwk: { ...(await exportJWK(publicKey)), kid } };
}

/** Pinned keys per entity ID that the tenant `tenant` registered. */
function anchorKeys(pinned: Record<string, JWK[]> = { [TA]: [taJwk] }) {
    return {
        findPinnedKeys: vi.fn(async (tenantId: string, ids: string[]) =>
            tenantId === "tenant"
                ? new Map(
                      ids
                          .filter((id) => pinned[id])
                          .map((id) => [id, { keys: pinned[id] }]),
                  )
                : new Map(),
        ),
    };
}

beforeAll(async () => {
    ({ jwt: taEntityConfiguration, jwk: taJwk } =
        await entityConfiguration(TA));
});

describe("FederationTrustService", () => {
    let resolveEntity: ReturnType<typeof vi.fn>;
    let service: FederationTrustService;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
        resolveEntity = vi.fn();
        service = new FederationTrustService({ resolveEntity }, anchorKeys());
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("passes the entity, pinned trust anchors and metadata types to the resolver", async () => {
        resolveEntity.mockResolvedValue(resolution());

        await service.resolveEntity(ENTITY, source, [
            "openid_credential_issuer",
        ]);

        expect(resolveEntity).toHaveBeenCalledWith({
            entityId: ENTITY,
            trustAnchors: [{ entityId: TA, jwks: { keys: [taJwk] } }],
            metadataTypes: ["openid_credential_issuer"],
        });
    });

    it("rejects trust anchors the tenant has not registered with pinned keys", async () => {
        await expect(
            service.resolveEntity(ENTITY, { ...source, tenantId: "other" }),
        ).rejects.toMatchObject({
            failure: "untrusted",
            message: expect.stringContaining("registered with pinned keys"),
        });
        await expect(
            service.resolveEntity(ENTITY, { ...source, tenantId: undefined }),
        ).rejects.toMatchObject({ failure: "untrusted" });
        expect(resolveEntity).not.toHaveBeenCalled();
    });

    it("leaves out trust anchors without pinned keys", async () => {
        resolveEntity.mockResolvedValue(resolution());

        await service.resolveEntity(ENTITY, {
            ...source,
            trustAnchors: [
                ...source.trustAnchors,
                {
                    entityId: "https://unpinned.example.org",
                    entityConfigurationUri:
                        "https://unpinned.example.org/.well-known/openid-federation",
                },
            ],
        });

        expect(resolveEntity.mock.calls[0][0].trustAnchors).toEqual([
            { entityId: TA, jwks: { keys: [taJwk] } },
        ]);
    });

    it("rejects a chain whose trust anchor entity configuration is not signed with a pinned key", async () => {
        // For example a trust engine that trusts other keys for the anchor.
        const forged = await entityConfiguration(TA);
        resolveEntity.mockResolvedValue({
            ...resolution(),
            trustChain: ["ec", "ss", forged.jwt],
        });

        await expect(
            service.resolveEntity(ENTITY, source),
        ).rejects.toMatchObject({
            failure: "untrusted",
            message: `entity configuration of trust anchor ${TA} is not signed with a pinned key`,
        });
    });

    it("rejects a resolution that ends at a trust anchor that was not requested", async () => {
        resolveEntity.mockResolvedValue({
            ...resolution(),
            trustAnchor: "https://other.example.org",
        });

        await expect(
            service.resolveEntity(ENTITY, source),
        ).rejects.toMatchObject({
            failure: "untrusted",
            message: "trust anchor https://other.example.org is not configured",
        });
    });

    it("rejects a chain that does not end with the trust anchor's entity configuration", async () => {
        const other = await entityConfiguration("https://other.example.org");
        resolveEntity.mockResolvedValue({
            ...resolution(),
            trustChain: ["ec", "ss", other.jwt],
        });

        await expect(
            service.resolveEntity(ENTITY, source),
        ).rejects.toMatchObject({
            failure: "untrusted",
            message: expect.stringContaining(
                "is not the entity configuration of trust anchor",
            ),
        });
    });

    it("keeps resolutions for different pinned keys apart", async () => {
        resolveEntity.mockResolvedValue(resolution());
        const rotated = { ...taJwk, kid: "ta-2" };
        const keys = anchorKeys();
        const shared = new FederationTrustService({ resolveEntity }, keys);

        await shared.resolveEntity(ENTITY, source);
        keys.findPinnedKeys.mockResolvedValue(
            new Map([[TA, { keys: [taJwk, rotated] }]]),
        );
        await shared.resolveEntity(ENTITY, source);

        expect(resolveEntity).toHaveBeenCalledTimes(2);
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

    it("clears only the resolutions a tenant used", async () => {
        const keys = anchorKeys();
        keys.findPinnedKeys.mockImplementation(
            async (_tenantId: string, ids: string[]) =>
                new Map(
                    ids
                        .filter((id) => id === TA)
                        .map((id) => [id, { keys: [taJwk] }]),
                ),
        );
        service = new FederationTrustService({ resolveEntity }, keys);
        resolveEntity.mockResolvedValue(resolution());
        const other = { ...source, tenantId: "other" };
        const issuer = ["openid_credential_issuer"];
        const authorizationServer = ["oauth_authorization_server"];

        await service.resolveEntity(ENTITY, source, issuer);
        await service.resolveEntity(ENTITY, other, authorizationServer);
        service.clearTrustCache("other");

        await service.resolveEntity(ENTITY, source, issuer);
        expect(resolveEntity).toHaveBeenCalledTimes(2);
        await service.resolveEntity(ENTITY, other, authorizationServer);
        expect(resolveEntity).toHaveBeenCalledTimes(3);
    });

    it("keeps the earlier resolution of a shared entry when a tenant clears it", async () => {
        const keys = anchorKeys();
        keys.findPinnedKeys.mockImplementation(
            async (_tenantId: string, ids: string[]) =>
                new Map(
                    ids
                        .filter((id) => id === TA)
                        .map((id) => [id, { keys: [taJwk] }]),
                ),
        );
        service = new FederationTrustService({ resolveEntity }, keys);
        const earlier = resolution();
        resolveEntity.mockResolvedValueOnce(earlier);
        const other = { ...source, tenantId: "other" };

        await service.resolveEntity(ENTITY, source);
        await service.resolveEntity(ENTITY, other);
        service.clearTrustCache("other");

        resolveEntity.mockRejectedValue(
            new FederationResolutionError("timeout", "unavailable"),
        );
        await expect(service.resolveEntity(ENTITY, source)).resolves.toBe(
            earlier,
        );
        // Resolved again: the shared entry was cleared, its fallback kept.
        expect(resolveEntity).toHaveBeenCalledTimes(2);
    });

    it("drops the earlier resolution of an entry only the clearing tenant used", async () => {
        resolveEntity.mockResolvedValueOnce(resolution());

        await service.resolveEntity(ENTITY, source);
        service.clearTrustCache("tenant");

        resolveEntity.mockRejectedValue(
            new FederationResolutionError("timeout", "unavailable"),
        );
        await expect(service.resolveEntity(ENTITY, source)).rejects.toThrow(
            "timeout",
        );
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
        const counted = new FederationTrustService(
            { resolveEntity },
            anchorKeys(),
            {
                getCounter: vi.fn((name: string) => ({
                    add: (value: number, labels: object) =>
                        add(name, value, labels),
                })),
            } as never,
        );
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
