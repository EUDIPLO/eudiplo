import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import type { HttpService } from "@nestjs/axios";
import type { JWK } from "jose";
import { of } from "rxjs";
import { describe, expect, it } from "vitest";
import type { KmsKeyRef } from "../kms-adapter.js";
import { CscKmsAdapter, type CscKmsAdapterConfig } from "./csc-kms.adapter.js";

/** OIDs written out independently of the adapter's tables. */
const SHA384_OID = "2.16.840.1.101.3.4.2.2";
const ECDSA_WITH_SHA384_OID = "1.2.840.10045.4.3.3";

const BASE_URL = "https://csc.example";
const TOKEN_URL = "https://csc.example/oauth2/token";

/**
 * A stand-in for the CSC service: the token endpoint returns a token,
 * credentials/authorize a SAD, and signatures/signHash signs with the P-384
 * key in the requested signature encoding. Node cannot sign a bare digest,
 * so the fake knows the signed data and refuses a digest that is not its
 * SHA-384 hash.
 */
function createFakeCsc(
    data: Uint8Array,
    signatureEncoding: "ieee-p1363" | "der",
) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", {
        namedCurve: "secp384r1",
    });
    const requests: { url: string; body: any }[] = [];
    const http = {
        post: (url: string, body: any) => {
            requests.push({ url, body });
            if (url === TOKEN_URL) {
                return of({ data: { access_token: "token" } });
            }
            if (url.endsWith("/credentials/authorize")) {
                return of({ data: { SAD: "sad" } });
            }
            if (url.endsWith("/signatures/signHash")) {
                if (
                    body.hashes[0] !==
                    createHash("sha384").update(data).digest("base64")
                ) {
                    throw new Error("Digest is not the SHA-384 of the data");
                }
                const signature = sign("sha384", data, {
                    key: privateKey,
                    dsaEncoding: signatureEncoding,
                });
                return of({
                    data: { signatures: [signature.toString("base64")] },
                });
            }
            throw new Error(`Unexpected request to ${url}`);
        },
    } as unknown as HttpService;
    const ref: KmsKeyRef = {
        externalKeyId: "credential-1",
        publicJwk: publicKey.export({ format: "jwk" }) as JWK,
        alg: "ES384",
    };
    const signHashBodies = () =>
        requests
            .filter((r) => r.url.endsWith("/signatures/signHash"))
            .map((r) => r.body);
    const authorizeBodies = () =>
        requests
            .filter((r) => r.url.endsWith("/credentials/authorize"))
            .map((r) => r.body);
    return { http, publicKey, ref, signHashBodies, authorizeBodies };
}

function adapter(
    http: HttpService,
    config: Partial<CscKmsAdapterConfig> = {},
): CscKmsAdapter {
    return new CscKmsAdapter(
        {
            providerId: "csc",
            baseUrl: BASE_URL,
            tokenUrl: TOKEN_URL,
            clientId: "client",
            clientSecret: "secret",
            algorithms: { algorithms: ["ES384"] },
            ...config,
        },
        http,
    );
}

describe("CscKmsAdapter ES384", () => {
    const data = new TextEncoder().encode("payload");

    it("returns a raw 96-byte r||s signature unchanged", async () => {
        const csc = createFakeCsc(data, "ieee-p1363");

        const signature = await adapter(csc.http).sign(csc.ref, data);

        expect(signature).toHaveLength(96);
        const [body] = csc.signHashBodies();
        expect(body).toMatchObject({
            credentialID: "credential-1",
            hashAlgorithmOID: SHA384_OID,
            signAlgo: ECDSA_WITH_SHA384_OID,
        });
        expect(body.hashes).toEqual([
            createHash("sha384").update(data).digest("base64"),
        ]);
        expect(
            verify(
                "sha384",
                data,
                { key: csc.publicKey, dsaEncoding: "ieee-p1363" },
                signature,
            ),
        ).toBe(true);
    });

    it("converts a DER signature to raw r||s", async () => {
        const csc = createFakeCsc(data, "der");

        const signature = await adapter(csc.http).sign(csc.ref, data);

        expect(signature).toHaveLength(96);
        expect(
            verify(
                "sha384",
                data,
                { key: csc.publicKey, dsaEncoding: "ieee-p1363" },
                signature,
            ),
        ).toBe(true);
    });

    it("sends configured hash and signature OIDs as they are", async () => {
        const csc = createFakeCsc(data, "ieee-p1363");
        // Deliberately not the ES384 OIDs: configured values win over the
        // ones derived from the key's algorithm.
        const hashAlgorithmOid = "1.3.6.1.4.1.99999.1";
        const signAlgorithmOid = "1.3.6.1.4.1.99999.2";

        await adapter(csc.http, {
            hashAlgorithmOid,
            signAlgorithmOid,
            useAuthorizeEndpoint: true,
        }).sign(csc.ref, data);

        expect(csc.authorizeBodies()).toEqual([
            expect.objectContaining({ hashAlgorithmOID: hashAlgorithmOid }),
        ]);
        expect(csc.signHashBodies()).toEqual([
            expect.objectContaining({
                hashAlgorithmOID: hashAlgorithmOid,
                signAlgo: signAlgorithmOid,
                SAD: "sad",
                // The digest still follows the key's algorithm.
                hashes: [createHash("sha384").update(data).digest("base64")],
            }),
        ]);
    });
});

describe("CscKmsAdapter request path", () => {
    const create = (apiPath?: string) =>
        new CscKmsAdapter(
            {
                providerId: "csc",
                baseUrl: "https://csc.example.com",
                tokenUrl: "https://csc.example.com/token",
                clientId: "client",
                clientSecret: "secret",
                apiPath,
            },
            {} as any,
        );

    it("accepts the default and a path on the server of baseUrl", () => {
        expect(() => create()).not.toThrow();
        expect(() => create("/csc/v1")).not.toThrow();
    });

    // The credentials of the provider would be sent to another server.
    it.each([".attacker.example/csc/v2", "@attacker.example/csc"])(
        "refuses %j",
        (apiPath) => {
            expect(() => create(apiPath)).toThrow(
                /apiPath must be a path on the server of baseUrl/,
            );
        },
    );
});
