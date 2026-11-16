import type { ConfigService } from "@nestjs/config";
import type { Jwk, JwsSigner } from "@owf/jose";
import { exportJWK, generateKeyPair } from "jose";
import type { PinoLogger } from "nestjs-pino";
import { describe, expect, it, vi } from "vitest";
import { CryptoService } from "./crypto.service.js";
import type { KeyChainService } from "./key/key-chain.service.js";

const signingInput = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0";

async function setup() {
    const { privateKey, publicKey } = await generateKeyPair("ES256", {
        extractable: true,
    });
    const publicJwk = {
        ...(await exportJWK(publicKey)),
        kid: "published",
    } as Jwk;
    const keyChainService = {
        getPublicKey: vi.fn(async (_type, _tenant, id: string) => {
            if (id !== "chain-1") throw new Error(`Key chain ${id} not found`);
            return publicJwk;
        }),
        getSigningAlg: vi.fn().mockResolvedValue("ES256"),
        signBytes: vi.fn(
            async (data: Uint8Array) =>
                new Uint8Array(
                    await crypto.subtle.sign(
                        { name: "ECDSA", hash: "SHA-256" },
                        privateKey as CryptoKey,
                        data as Uint8Array<ArrayBuffer>,
                    ),
                ),
        ),
    };
    const service = new CryptoService(
        keyChainService as unknown as KeyChainService,
        { getOrThrow: () => 5 } as unknown as ConfigService,
        { setContext: vi.fn(), warn: vi.fn() } as unknown as PinoLogger,
    );
    return { service, keyChainService, publicJwk };
}

const context = {
    signingInput,
    signingInputBytes: new TextEncoder().encode(signingInput),
    protectedHeader: { alg: "ES256" },
    payload: new Uint8Array(),
};

describe("CryptoService", () => {
    it("signs for a custom signer with the key chain its kid maps to, and the result verifies", async () => {
        const { service, keyChainService, publicJwk } = await setup();
        const callbacks = service.getCallbackContext("tenant", undefined, {
            published: "chain-1",
        });

        const { signature, signerJwk } = await callbacks.signJws(
            { method: "custom", alg: "ES256", kid: "published" },
            context as never,
        );

        expect(keyChainService.signBytes).toHaveBeenCalledWith(
            context.signingInputBytes,
            "tenant",
            "chain-1",
        );
        expect(signerJwk).toEqual(publicJwk);
        await expect(
            callbacks.verifyJws({ method: "jwk", alg: "ES256", publicJwk }, {
                ...context,
                signature,
            } as never),
        ).resolves.toEqual({ verified: true, signerJwk: publicJwk });
    });

    it.each<[string, JwsSigner, string]>([
        [
            "a signer of another method",
            { method: "x5c", alg: "ES256", x5c: ["MAA="], kid: "chain-1" },
            "Signer method not supported",
        ],
        [
            "a signer without key id",
            { method: "custom", alg: "ES256" },
            "Signer has no key id",
        ],
        [
            "an alg the key does not have",
            { method: "custom", alg: "ES384", kid: "chain-1" },
            "does not match the key's alg",
        ],
    ])("refuses to sign for %s", async (_, signer, message) => {
        const { service } = await setup();

        await expect(
            service.getSignJwsCallback("tenant")(signer, context as never),
        ).rejects.toThrow(message);
    });

    it("refuses to sign for a jwk signer whose key is not the key chain's", async () => {
        const { service } = await setup();
        const other = (await exportJWK(
            (
                await generateKeyPair("ES256", { extractable: true })
            ).publicKey,
        )) as Jwk;

        await expect(
            service.getSignJwsCallback("tenant")(
                {
                    method: "jwk",
                    alg: "ES256",
                    publicJwk: other,
                    kid: "chain-1",
                },
                context as never,
            ),
        ).rejects.toThrow("No private key available");
    });

    it("does not verify a signature under another alg, or an x5c signer without certificates", async () => {
        const { service, publicJwk } = await setup();
        const callbacks = service.getCallbackContext("tenant", undefined, {
            published: "chain-1",
        });
        const { signature } = await callbacks.signJws(
            { method: "custom", alg: "ES256", kid: "published" },
            context as never,
        );

        await expect(
            callbacks.verifyJws({ method: "jwk", alg: "ES384", publicJwk }, {
                ...context,
                signature,
            } as never),
        ).resolves.toEqual({ verified: false });
        await expect(
            callbacks.verifyJws({ method: "x5c", alg: "ES256", x5c: [] }, {
                ...context,
                signature,
            } as never),
        ).resolves.toEqual({ verified: false });
    });
});
