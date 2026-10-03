import { createHash, randomUUID } from "node:crypto";
import type { CallbackContext } from "@openid4vc/oauth2";
import {
    calculateJwkThumbprint,
    exportJWK,
    generateKeyPair,
    importJWK,
    type JWK,
    jwtVerify,
    SignJWT,
} from "jose";
import { describe, expect, it, vi } from "vitest";
import {
    dpopProofExpiresAt,
    dpopProofVerification,
    verifyDpopProof,
} from "./dpop.util.js";

describe("dpopProofExpiresAt", () => {
    it("keeps the proof until iat plus the maximum age and clock skew", () => {
        expect(dpopProofExpiresAt(1_000, new Date(0))).toEqual(
            new Date((1_000 + 300 + 60) * 1000),
        );
    });

    it("covers a proof issued within the allowed skew in the future", () => {
        const now = new Date(1_000_000);
        const iat = 1_000 + 60;
        // The library accepts this proof until iat + 300 + 60 seconds.
        expect(dpopProofExpiresAt(iat, now).getTime()).toBe((iat + 360) * 1000);
    });

    it("starts the window at now without iat", () => {
        expect(dpopProofExpiresAt(undefined, new Date(5_000))).toEqual(
            new Date(5_000 + 360_000),
        );
        expect(dpopProofExpiresAt(Number.NaN, new Date(5_000))).toEqual(
            new Date(5_000 + 360_000),
        );
    });
});

describe("dpopProofVerification", () => {
    it("passes the freshness window and a jti check bound to the registry", async () => {
        const registry = { register: vi.fn().mockResolvedValue(true) };
        const options = dpopProofVerification(registry);

        expect(options).toMatchObject({
            maxProofAgeSeconds: 300,
            allowedClockSkewSeconds: 60,
        });
        await expect(
            options.assertJtiUniqueness({
                header: {} as never,
                payload: { jti: "jti-1", iat: 1_000 } as never,
                signature: "",
                jwkThumbprint: "jkt-1",
                now: new Date(1_000_000),
            }),
        ).resolves.toBe(true);
        expect(registry.register).toHaveBeenCalledWith(
            "jkt-1",
            "jti-1",
            new Date(1_360_000),
        );
    });

    it("reports a replay when the registry already knows the proof", async () => {
        const registry = { register: vi.fn().mockResolvedValue(false) };
        await expect(
            dpopProofVerification(registry).assertJtiUniqueness({
                header: {} as never,
                payload: { jti: "jti-1", iat: 1_000 } as never,
                signature: "",
                jwkThumbprint: "jkt-1",
                now: new Date(1_000_000),
            }),
        ).resolves.toBe(false);
    });
});

describe("verifyDpopProof", () => {
    const url = "https://issuer.example/issuers/t1/chained-as/token";
    const authorizationServerMetadata = {
        issuer: "https://issuer.example/issuers/t1/chained-as",
        token_endpoint: url,
        dpop_signing_alg_values_supported: ["ES256"],
    };
    const callbacks: Pick<CallbackContext, "hash" | "verifyJwt"> = {
        hash: (data, alg) =>
            createHash(alg.replace("-", "").toLowerCase())
                .update(data)
                .digest(),
        verifyJwt: async (signer, { compact }) => {
            if (signer.method !== "jwk") return { verified: false };
            try {
                await jwtVerify(
                    compact,
                    await importJWK(signer.publicJwk as JWK, signer.alg),
                );
                return { verified: true, signerJwk: signer.publicJwk };
            } catch {
                return { verified: false };
            }
        },
    };

    async function holderKey(alg = "ES256") {
        const { privateKey, publicKey } = await generateKeyPair(alg, {
            extractable: true,
        });
        return { privateKey, jwk: await exportJWK(publicKey) };
    }

    type HolderKey = Awaited<ReturnType<typeof holderKey>>;

    function proof(
        key: HolderKey,
        overrides: {
            header?: Record<string, unknown>;
            payload?: Record<string, unknown>;
        } = {},
        signingKey: HolderKey["privateKey"] = key.privateKey,
    ) {
        return new SignJWT({
            htm: "POST",
            htu: url,
            iat: Math.floor(Date.now() / 1000),
            jti: randomUUID(),
            ...overrides.payload,
        })
            .setProtectedHeader({
                alg: "ES256",
                typ: "dpop+jwt",
                jwk: key.jwk,
                ...overrides.header,
            })
            .sign(signingKey);
    }

    const verify = (
        jwt: string | undefined,
        options: { expectedJwkThumbprint?: string; required?: boolean } = {},
        registry = { register: vi.fn().mockResolvedValue(true) },
    ) =>
        verifyDpopProof(
            {
                jwt,
                request: { method: "POST", url },
                authorizationServerMetadata,
                ...options,
            },
            callbacks,
            registry,
        );

    const invalidProof = expect.objectContaining({
        code: "invalid_dpop_proof",
    });

    it("returns the RFC 7638 thumbprint of a valid proof and records its jti", async () => {
        const key = await holderKey();
        const registry = { register: vi.fn().mockResolvedValue(true) };
        const thumbprint = await calculateJwkThumbprint(key.jwk, "sha256");

        await expect(verify(await proof(key), {}, registry)).resolves.toBe(
            thumbprint,
        );
        await expect(
            verify(await proof(key), { expectedJwkThumbprint: thumbprint }),
        ).resolves.toBe(thumbprint);
        expect(registry.register).toHaveBeenCalledWith(
            thumbprint,
            expect.any(String),
            expect.any(Date),
        );
    });

    it("ignores the query and fragment of htu", async () => {
        const key = await holderKey();
        await expect(
            verify(await proof(key, { payload: { htu: `${url}?a=b#c` } })),
        ).resolves.toBeDefined();
    });

    it("returns undefined without a proof unless one is required", async () => {
        await expect(verify(undefined)).resolves.toBeUndefined();
        await expect(verify(undefined, { required: true })).rejects.toEqual(
            invalidProof,
        );
    });

    it("rejects a proof signed by another key than its jwk", async () => {
        const key = await holderKey();
        const attacker = await holderKey();
        const forged = await proof(key, {}, attacker.privateKey);

        await expect(verify(forged)).rejects.toEqual(invalidProof);
    });

    it.each([
        ["wrong typ", { header: { typ: "JWT" } }],
        ["wrong htm", { payload: { htm: "GET" } }],
        [
            "wrong htu",
            { payload: { htu: "https://issuer.example/issuers/t1/other" } },
        ],
        [
            "stale iat",
            { payload: { iat: Math.floor(Date.now() / 1000) - 3600 } },
        ],
        [
            "iat in the future",
            { payload: { iat: Math.floor(Date.now() / 1000) + 3600 } },
        ],
        ["no jti", { payload: { jti: undefined } }],
    ])("rejects a proof with %s", async (_, overrides) => {
        const key = await holderKey();
        await expect(verify(await proof(key, overrides))).rejects.toEqual(
            invalidProof,
        );
    });

    it("rejects an algorithm that is not advertised", async () => {
        const key = await holderKey("ES384");
        await expect(
            verify(await proof(key, { header: { alg: "ES384" } })),
        ).rejects.toEqual(invalidProof);
    });

    it("rejects a jwk that contains the private key", async () => {
        const key = await holderKey();
        const privateJwk = await exportJWK(key.privateKey);
        await expect(
            verify(await proof(key, { header: { jwk: privateJwk } })),
        ).rejects.toEqual(
            expect.objectContaining({
                code: "invalid_dpop_proof",
                description: expect.stringContaining("private key"),
            }),
        );
    });

    it("rejects an unsigned or malformed proof", async () => {
        const key = await holderKey();
        const encode = (value: object) =>
            Buffer.from(JSON.stringify(value)).toString("base64url");
        const unsigned = `${encode({ alg: "none", typ: "dpop+jwt", jwk: key.jwk })}.${encode(
            {
                htm: "POST",
                htu: url,
                iat: Math.floor(Date.now() / 1000),
                jti: randomUUID(),
            },
        )}.`;

        await expect(verify(unsigned)).rejects.toEqual(invalidProof);
        await expect(verify("not-a-jwt")).rejects.toEqual(invalidProof);
    });

    it("describes the failed check but not internal errors", async () => {
        const key = await holderKey();
        await expect(
            verify(await proof(key, { payload: { htm: "GET" } })),
        ).rejects.toEqual(
            expect.objectContaining({
                code: "invalid_dpop_proof",
                description: expect.stringContaining("htm"),
            }),
        );
        await expect(
            verify(
                await proof(key),
                {},
                { register: vi.fn().mockRejectedValue(new Error("db down")) },
            ),
        ).rejects.toEqual(
            expect.objectContaining({
                code: "invalid_dpop_proof",
                description: "Invalid DPoP proof",
            }),
        );
    });

    it("rejects a replayed proof", async () => {
        const key = await holderKey();
        await expect(
            verify(
                await proof(key),
                {},
                { register: vi.fn().mockResolvedValue(false) },
            ),
        ).rejects.toEqual(invalidProof);
    });

    it("rejects a proof signed with another key than the bound one", async () => {
        const key = await holderKey();
        const bound = await holderKey();
        await expect(
            verify(await proof(key), {
                expectedJwkThumbprint: await calculateJwkThumbprint(
                    bound.jwk,
                    "sha256",
                ),
            }),
        ).rejects.toEqual(invalidProof);
    });
});
