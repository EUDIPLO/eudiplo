import {
    createEntityConfiguration,
    createEntityStatement,
    type JsonWebKey,
    type SignCallback,
} from "@openid-federation/core";
import { beforeEach, describe, expect, it } from "vitest";
import type { OutboundFinalResponse } from "../../webhook/outbound-url-policy.service.js";
import {
    type TrustFetchOptions,
    TrustFetchStatusError,
} from "../trust-fetch.service.js";
import { LocalFederationResolver } from "./local-federation-resolver.js";

const TA = "https://ta.example.org";
const INTERMEDIATE = "https://intermediate.example.org";
const LEAF = "https://issuer.example.org";
const DAY = 24 * 60 * 60;
const CONTENT_TYPE = "application/entity-statement+jwt";

const privateKeys = new Map<string, CryptoKey>();

async function createKey(kid: string): Promise<JsonWebKey> {
    const keys = (await crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["sign", "verify"],
    )) as CryptoKeyPair;
    privateKeys.set(kid, keys.privateKey);
    const { kty, crv, x, y } = await crypto.subtle.exportKey(
        "jwk",
        keys.publicKey,
    );
    return { kid, kty: kty!, crv, x, y, alg: "ES256" } as JsonWebKey;
}

const signJwtCallback: SignCallback = async ({ toBeSigned, jwk }) =>
    new Uint8Array(
        await crypto.subtle.sign(
            { name: "ECDSA", hash: "SHA-256" },
            privateKeys.get(jwk.kid)!,
            toBeSigned,
        ),
    );

const now = () => Math.floor(Date.now() / 1000);

/** An in-memory federation served through a TrustFetchService stub. */
class Federation {
    readonly responses = new Map<string, OutboundFinalResponse>();
    readonly options: TrustFetchOptions[] = [];
    failing = new Set<string>();
    statusFor = new Map<string, number>();

    serve(url: string, body: string, contentType = CONTENT_TYPE) {
        this.responses.set(url, {
            url,
            status: 200,
            body,
            bytes: Buffer.from(body),
            contentType,
        });
    }

    async entity(
        id: string,
        key: JsonWebKey,
        claims: Record<string, unknown> = {},
    ) {
        const jwt = await createEntityConfiguration({
            signJwtCallback,
            header: { kid: key.kid, typ: "entity-statement+jwt", alg: "ES256" },
            claims: {
                iss: id,
                sub: id,
                iat: now(),
                exp: now() + DAY,
                jwks: { keys: [key] },
                ...claims,
                metadata: {
                    federation_entity: {
                        federation_fetch_endpoint: `${id}/fetch`,
                    },
                    ...(claims.metadata as object),
                },
            },
        });
        this.serve(`${id}/.well-known/openid-federation`, jwt);
    }

    async statement(
        issuer: string,
        issuerKey: JsonWebKey,
        subject: string,
        subjectKey: JsonWebKey,
        claims: Record<string, unknown> = {},
    ) {
        const jwt = await createEntityStatement({
            signJwtCallback,
            jwk: issuerKey,
            header: {
                kid: issuerKey.kid,
                typ: "entity-statement+jwt",
                alg: "ES256",
            } as never,
            claims: {
                iss: issuer,
                sub: subject,
                iat: now(),
                exp: now() + DAY,
                jwks: { keys: [subjectKey] },
                ...claims,
            },
        });
        this.serve(
            `${issuer}/fetch?${new URLSearchParams({ sub: subject })}`,
            jwt,
        );
    }

    trustFetch = {
        get: async (url: string, options: TrustFetchOptions) => {
            this.options.push(options);
            if (this.failing.has(url)) throw new Error("connection refused");
            const status = this.statusFor.get(url);
            if (status) throw new TrustFetchStatusError(status);
            const response = this.responses.get(url);
            if (!response) {
                throw new TrustFetchStatusError(404);
            }
            return response;
        },
    };
}

const credentialKey = {
    kid: "credential-key",
    kty: "EC",
    crv: "P-256",
    x: "x",
    y: "y",
};

describe("LocalFederationResolver", () => {
    let federation: Federation;
    let resolver: LocalFederationResolver;
    let taKey: JsonWebKey;
    let intermediateKey: JsonWebKey;
    let leafKey: JsonWebKey;

    beforeEach(async () => {
        federation = new Federation();
        resolver = new LocalFederationResolver(federation.trustFetch, 0);
        taKey = await createKey("ta");
        intermediateKey = await createKey("intermediate");
        leafKey = await createKey("leaf");

        await federation.entity(TA, taKey);
        await federation.entity(INTERMEDIATE, intermediateKey, {
            authority_hints: [TA],
        });
        await federation.entity(LEAF, leafKey, {
            authority_hints: [INTERMEDIATE],
            metadata: {
                openid_credential_issuer: {
                    credential_issuer: LEAF,
                    jwks: { keys: [credentialKey] },
                },
            },
        });
        await federation.statement(TA, taKey, INTERMEDIATE, intermediateKey);
        await federation.statement(
            INTERMEDIATE,
            intermediateKey,
            LEAF,
            leafKey,
        );
    });

    const request = (overrides = {}) => ({
        entityId: LEAF,
        trustAnchors: [{ entityId: TA }],
        metadataTypes: ["openid_credential_issuer"],
        ...overrides,
    });

    it("resolves leaf -> intermediate -> trust anchor with the protocol keys of the metadata", async () => {
        const resolution = await resolver.resolveEntity(request());

        expect(resolution).toMatchObject({
            entityId: LEAF,
            trustAnchor: TA,
            metadata: {
                openid_credential_issuer: {
                    jwks: { keys: [credentialKey] },
                },
            },
        });
        expect(resolution.trustChain).toHaveLength(4);
        expect(Date.parse(resolution.expiresAt)).toBeGreaterThan(Date.now());
        // TLS certificates of federation entities are always verified
        expect(federation.options.every((options) => options.verifyTls)).toBe(
            true,
        );
    });

    it("resolves a leaf directly below the trust anchor", async () => {
        await federation.entity(LEAF, leafKey, { authority_hints: [TA] });
        await federation.statement(TA, taKey, LEAF, leafKey);

        await expect(
            resolver.resolveEntity(request({ metadataTypes: undefined })),
        ).resolves.toMatchObject({ trustAnchor: TA });
    });

    it("applies the metadata policies of the chain", async () => {
        await federation.statement(TA, taKey, INTERMEDIATE, intermediateKey, {
            metadata_policy: {
                openid_credential_issuer: {
                    display_name: { value: "Policy name" },
                },
            },
        });

        const resolution = await resolver.resolveEntity(request());

        expect(resolution.metadata.openid_credential_issuer.display_name).toBe(
            "Policy name",
        );
    });

    it("rejects an unknown trust anchor", async () => {
        await expect(
            resolver.resolveEntity(
                request({
                    trustAnchors: [
                        { entityId: "https://other-ta.example.org" },
                    ],
                }),
            ),
        ).rejects.toMatchObject({ failure: "untrusted" });
    });

    it("rejects an entity without the requested metadata type", async () => {
        await expect(
            resolver.resolveEntity(
                request({ metadataTypes: ["oauth_authorization_server"] }),
            ),
        ).rejects.toMatchObject({
            failure: "untrusted",
            message: expect.stringContaining(
                "has no oauth_authorization_server",
            ),
        });
    });

    it("rejects authority_hints that name the trust anchor without a subordinate statement", async () => {
        const rogue = "https://rogue.example.net";
        const rogueKey = await createKey("rogue");
        await federation.entity(rogue, rogueKey, {
            authority_hints: [TA],
            metadata: {
                openid_credential_issuer: { jwks: { keys: [credentialKey] } },
            },
        });

        await expect(
            resolver.resolveEntity(request({ entityId: rogue })),
        ).rejects.toMatchObject({
            failure: "untrusted",
            message: expect.stringContaining("status 404"),
        });
    });

    it("rejects an entity configuration with an invalid signature", async () => {
        const configuration = federation.responses.get(
            `${LEAF}/.well-known/openid-federation`,
        )!;
        const [header, payload] = configuration.body.split(".");
        federation.serve(
            `${LEAF}/.well-known/openid-federation`,
            `${header}.${payload}.${Buffer.from("forged").toString("base64url")}`,
        );

        await expect(resolver.resolveEntity(request())).rejects.toMatchObject({
            failure: "untrusted",
        });
    });

    it("rejects an unsigned entity configuration", async () => {
        const payload = Buffer.from(
            JSON.stringify({
                iss: LEAF,
                sub: LEAF,
                iat: now(),
                exp: now() + DAY,
                jwks: { keys: [leafKey] },
                authority_hints: [TA],
            }),
        ).toString("base64url");
        const header = Buffer.from(
            JSON.stringify({
                alg: "none",
                kid: "leaf",
                typ: "entity-statement+jwt",
            }),
        ).toString("base64url");
        federation.serve(
            `${LEAF}/.well-known/openid-federation`,
            `${header}.${payload}.`,
        );

        await expect(resolver.resolveEntity(request())).rejects.toMatchObject({
            failure: "untrusted",
        });
    });

    it("rejects an expired entity configuration", async () => {
        await federation.entity(LEAF, leafKey, {
            authority_hints: [INTERMEDIATE],
            exp: now() - 10,
        });

        await expect(resolver.resolveEntity(request())).rejects.toMatchObject({
            failure: "untrusted",
            message: expect.stringContaining("has expired"),
        });
    });

    it("rejects an entity configuration whose sub is another entity", async () => {
        await federation.entity(LEAF, leafKey, {
            authority_hints: [INTERMEDIATE],
        });
        const other = federation.responses.get(
            `${INTERMEDIATE}/.well-known/openid-federation`,
        )!;
        federation.serve(`${LEAF}/.well-known/openid-federation`, other.body);

        await expect(resolver.resolveEntity(request())).rejects.toMatchObject({
            failure: "untrusted",
            message: expect.stringContaining("has subject"),
        });
    });

    it("rejects a subordinate statement with an invalid signature", async () => {
        await federation.statement(
            INTERMEDIATE,
            await createKey("intermediate"),
            LEAF,
            leafKey,
        );

        await expect(resolver.resolveEntity(request())).rejects.toMatchObject({
            failure: "untrusted",
        });
    });

    it("reports an unreachable federation as unavailable", async () => {
        federation.failing.add(`${INTERMEDIATE}/.well-known/openid-federation`);

        await expect(resolver.resolveEntity(request())).rejects.toMatchObject({
            failure: "unavailable",
        });
    });

    it("rejects an authority_hints cycle within the request limit", async () => {
        const a = "https://a.example.net";
        const b = "https://b.example.net";
        await federation.entity(a, await createKey("a"), {
            authority_hints: [b],
        });
        await federation.entity(b, await createKey("b"), {
            authority_hints: [a],
        });
        await federation.entity(LEAF, leafKey, { authority_hints: [a] });

        await expect(resolver.resolveEntity(request())).rejects.toMatchObject({
            failure: "untrusted",
        });
        expect(federation.options.length).toBeLessThanOrEqual(3);
    });

    it("does not follow superiors beyond maxDepth", async () => {
        const shallow = new LocalFederationResolver(federation.trustFetch, 0, {
            maxDepth: 1,
            maxAuthorityHints: 10,
            maxRequests: 32,
        });

        await expect(shallow.resolveEntity(request())).rejects.toMatchObject({
            failure: "untrusted",
        });
        expect(
            federation.options.length,
            "the trust anchor is two levels up and never fetched",
        ).toBe(2);
    });

    it("prefers the shortest valid chain", async () => {
        await federation.entity(LEAF, leafKey, {
            authority_hints: [INTERMEDIATE, TA],
            metadata: {
                openid_credential_issuer: { jwks: { keys: [credentialKey] } },
            },
        });
        await federation.statement(TA, taKey, LEAF, leafKey);

        const resolution = await resolver.resolveEntity(request());

        expect(resolution.trustChain).toHaveLength(3);
    });

    it("resolves a configured trust anchor itself", async () => {
        const resolution = await resolver.resolveEntity(
            request({ entityId: TA, metadataTypes: undefined }),
        );

        expect(resolution.trustAnchor).toBe(TA);
        expect(resolution.trustChain).toHaveLength(1);
    });

    it.each([429, 503])(
        "reports a %s answer as unavailable",
        async (status) => {
            federation.statusFor.set(
                `${INTERMEDIATE}/fetch?${new URLSearchParams({ sub: LEAF })}`,
                status,
            );

            await expect(
                resolver.resolveEntity(request()),
            ).rejects.toMatchObject({ failure: "unavailable" });
        },
    );

    it("reports untrusted when one path is unreachable and another fails validation", async () => {
        // Only a definite result keeps an earlier resolution from being reused
        const second = "https://second.example.org";
        const secondKey = await createKey("second");
        await federation.entity(second, secondKey, { authority_hints: [TA] });
        await federation.statement(TA, taKey, second, secondKey);
        await federation.statement(
            second,
            await createKey("second"),
            LEAF,
            leafKey,
        );
        await federation.entity(LEAF, leafKey, {
            authority_hints: [INTERMEDIATE, second],
            metadata: {
                openid_credential_issuer: { jwks: { keys: [credentialKey] } },
            },
        });
        federation.failing.add(`${INTERMEDIATE}/.well-known/openid-federation`);

        await expect(resolver.resolveEntity(request())).rejects.toMatchObject({
            failure: "untrusted",
        });
    });

    it("keeps a hostile authority_hints fan-out within the limits", async () => {
        const hints = Array.from(
            { length: 50 },
            (_, index) => `https://hint-${index}.example.net`,
        );
        await federation.entity(LEAF, leafKey, { authority_hints: hints });

        await expect(resolver.resolveEntity(request())).rejects.toMatchObject({
            failure: "untrusted",
        });
        // Ten hints of the leaf are followed, plus the leaf itself
        expect(federation.options.length).toBeLessThanOrEqual(11);
    });
});
