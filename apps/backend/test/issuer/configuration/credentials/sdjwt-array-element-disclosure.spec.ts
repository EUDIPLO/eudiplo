import { digest, ES256 } from "@owf/crypto";
import { decodeSdJwt } from "@sd-jwt/core";
import { SdJwtVcInstance } from "@sd-jwt/sd-jwt-vc";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { SdjwtvcIssuerService } from "../../../../src/issuer/configuration/credentials/issuer/sdjwtvc-issuer/sdjwtvc-issuer.service.js";
import type { ClaimFieldDefinition } from "../../../../src/issuer/configuration/credentials/utils/types.js";
import { SdJwtCredentialVerifierFormat } from "../../../../src/verifier/presentations/adapters/sd-jwt-credential-verifier-format.js";
import { SdjwtvcverifierService } from "../../../../src/verifier/presentations/credential/sdjwtvcverifier/sdjwtvcverifier.service.js";

/**
 * Round trip of array element disclosures (RFC 9901 Section 4.2.2): the
 * SD-JWT VC issuer turns disclosable element paths into one disclosure per
 * element, and EUDIPLO's own SD-JWT VC verifier accepts a presentation of
 * some of them for a DCQL query.
 */

const logger = {
    setContext: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
};

type KeyPair = Awaited<ReturnType<typeof ES256.generateKeyPair>>;

let issuerKey: KeyPair;
let holderKey: KeyPair;

beforeAll(async () => {
    issuerKey = await ES256.generateKeyPair();
    holderKey = await ES256.generateKeyPair();
});

function issuer(): SdjwtvcIssuerService {
    return new SdjwtvcIssuerService(
        {
            find: vi.fn().mockResolvedValue({ keyId: "key" }),
            getCertChain: vi.fn().mockReturnValue([]),
        } as any,
        { publicUrl: "https://issuer.example" } as any,
        {} as any,
        {
            getSigningAlg: vi.fn().mockResolvedValue("ES256"),
            signer: () => ES256.getSigner(issuerKey.privateKey),
        } as any,
    );
}

function issue(
    fields: ClaimFieldDefinition[],
    claims: Record<string, unknown>,
): Promise<string> {
    return issuer().issue({
        credentialConfiguration: {
            id: "pid",
            vct: "urn:example:pid",
            keyBinding: true,
            fields,
        } as any,
        holderCnf: holderKey.publicKey as any,
        session: { tenantId: "tenant" } as any,
        claims,
    });
}

async function disclosures(credential: string) {
    const decoded = await decodeSdJwt(credential, digest);
    return {
        payload: decoded.jwt.payload as Record<string, unknown>,
        disclosures: await Promise.all(
            decoded.disclosures.map(async (d) => ({
                key: d.key,
                value: d.value as unknown,
                digest: await d.digest({ hasher: digest, alg: "sha-256" }),
            })),
        ),
    };
}

const nationalities: ClaimFieldDefinition = {
    path: ["nationalities"],
    type: "array",
    disclosable: true,
    children: [{ path: [null], type: "string", disclosable: true }],
};

describe("SD-JWT VC array element disclosures", () => {
    it("issues one disclosure per element inside the disclosed array", async () => {
        const credential = await issue([nationalities], {
            nationalities: ["DE", "FR"],
        });
        const { payload, disclosures: all } = await disclosures(credential);

        expect(payload).not.toHaveProperty("nationalities");
        const array = all.find((d) => d.key === "nationalities");
        expect(payload._sd).toContain(array?.digest);

        const elements = all.filter((d) => d.key === undefined);
        expect(elements.map((d) => d.value)).toEqual(["DE", "FR"]);
        expect(array?.value).toEqual(
            elements.map((d) => ({ "...": d.digest })),
        );
    });

    it("issues element disclosures for properties of array element objects", async () => {
        const credential = await issue(
            [
                {
                    path: ["addresses"],
                    type: "array",
                    children: [
                        { path: ["street"], type: "string", disclosable: true },
                        { path: ["city"], type: "string" },
                    ],
                },
                {
                    path: ["addresses", 0],
                    type: "object",
                    disclosable: true,
                },
                // Beyond the issued array: ignored
                {
                    path: ["addresses", 7, "street"],
                    type: "string",
                    disclosable: true,
                },
            ],
            {
                addresses: [
                    { street: "A", city: "X" },
                    { street: "B", city: "Y" },
                ],
            },
        );
        const { payload, disclosures: all } = await disclosures(credential);

        const streets = all.filter((d) => d.key === "street");
        expect(streets.map((d) => d.value)).toEqual(["A", "B"]);
        const [first, second] = payload.addresses as Array<
            Record<string, unknown>
        >;
        const firstElement = all.find((d) => d.key === undefined);
        expect(first).toEqual({ "...": firstElement?.digest });
        expect(firstElement?.value).toEqual({
            city: "X",
            _sd: [streets[0].digest],
        });
        expect(second).toEqual({ city: "Y", _sd: [streets[1].digest] });
    });

    it("issues an empty disclosed array without element disclosures", async () => {
        const credential = await issue([nationalities], { nationalities: [] });
        const { disclosures: all } = await disclosures(credential);

        expect(all).toEqual([
            expect.objectContaining({ key: "nationalities", value: [] }),
        ]);
    });

    describe("verified by EUDIPLO", () => {
        const nonce = "nonce-123";
        const audience = "x509_hash:verifier";

        async function present(
            credential: string,
            frame: Record<string, unknown>,
        ): Promise<string> {
            const holder = new SdJwtVcInstance({
                hasher: digest,
                kbSigner: await ES256.getSigner(holderKey.privateKey),
                kbSignAlg: "ES256",
            });
            return holder.present(credential, frame as any, {
                kb: {
                    payload: {
                        iat: Math.floor(Date.now() / 1000),
                        aud: audience,
                        nonce,
                    },
                },
            });
        }

        function verify(
            presentation: string,
            claims: Array<{ path: any[]; values?: string[] }>,
        ) {
            const service = new SdjwtvcverifierService(
                {
                    resolvePublicKey: vi
                        .fn()
                        .mockResolvedValue(issuerKey.publicKey),
                } as any,
                { getCryptoFromJwk: () => ES256 } as any,
                {
                    validateChain: vi.fn().mockResolvedValue({
                        verified: true,
                        matchedEntity: null,
                    }),
                } as any,
                {} as any,
                {} as any,
                logger as any,
            );
            return new SdJwtCredentialVerifierFormat(
                service,
                logger as any,
            ).verify(presentation, {
                credentialId: "pid",
                binding: {
                    protocol: "openid4vp",
                    sessionId: "session",
                    useDcApi: false,
                    sessionNonce: nonce,
                    sessionClientId: audience,
                },
                options: {
                    policy: {
                        requireX5c: false,
                        revocation: { enabled: false, failClosed: false },
                    },
                } as any,
                claims: claims as any,
            });
        }

        it("accepts a presentation of some of the elements", async () => {
            const credential = await issue([nationalities], {
                nationalities: ["DE", "FR", "IT"],
            });
            const presentation = await present(credential, {
                nationalities: { 1: true },
            });

            const result = await verify(presentation, [
                { path: ["nationalities", 0], values: ["FR"] },
            ]);

            expect(result).toMatchObject({
                verified: true,
                claims: { nationalities: ["FR"] },
                missingClaims: [],
                mismatchedClaims: [],
            });
        });

        it("accepts a presentation of the whole array", async () => {
            const credential = await issue([nationalities], {
                nationalities: ["DE", "FR"],
            });
            const presentation = await present(credential, {
                nationalities: { 0: true, 1: true },
            });

            const result = await verify(presentation, [
                { path: ["nationalities"] },
            ]);

            expect(result).toMatchObject({
                verified: true,
                claims: { nationalities: ["DE", "FR"] },
                missingClaims: [],
            });
        });

        it("rejects a requested element that is not presented", async () => {
            const credential = await issue(
                [
                    {
                        path: ["nationalities", null],
                        type: "string",
                        disclosable: true,
                    },
                ],
                { nationalities: ["DE"] },
            );
            const presentation = await present(credential, {});

            await expect(
                verify(presentation, [{ path: ["nationalities", 0] }]),
            ).rejects.toThrow("Missing required claim keys: nationalities.0");
        });
    });
});
