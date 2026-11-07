import * as x509 from "@peculiar/x509";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrustStoreService } from "../../../trust/trust-store.service.js";
import { ServiceTypeIdentifiers } from "../../../trust/types.js";
import { X509ValidationService } from "../../../trust/x509-validation.service.js";
import {
    validateAttestationProofTrust,
    validateJwtProofAttestationTrust,
} from "./attestation-proof-trust.util.js";

// Signature and holder binding are checked by the OID4VCI library before these
// helpers run. These tests isolate the additional provider trust decision.
function jwt(header: Record<string, unknown>): string {
    return `${Buffer.from(JSON.stringify(header)).toString("base64url")}.e30.c2ln`;
}

describe("credential proof attestation trust", () => {
    const refs = [
        { url: "https://trust.example/list", verifierX509Der: "cert" },
    ];
    const getTrustStore = vi.fn();
    const matchAttestationSigner = vi.fn();
    const deps = {
        trustStoreService: { getTrustStore } as unknown as TrustStoreService,
        x509ValidationService: {
            matchAttestationSigner,
        } as unknown as X509ValidationService,
    };
    const entities = [{ services: [] }];

    beforeEach(() => {
        vi.resetAllMocks();
        getTrustStore.mockResolvedValue({ entities });
        matchAttestationSigner.mockResolvedValue({ entity: {} });
    });

    for (const proofType of ["attestation", "jwt"] as const) {
        const validate = (attestation: string, trustLists = refs) =>
            proofType === "attestation"
                ? validateAttestationProofTrust(attestation, trustLists, deps)
                : validateJwtProofAttestationTrust(
                      jwt({ key_attestation: attestation, jwk: { kty: "EC" } }),
                      trustLists,
                      deps,
                  );

        describe(proofType, () => {
            it("rejects attestation when no provider trust is configured", async () => {
                await expect(
                    validate(jwt({ x5c: ["cert"] }), []),
                ).rejects.toMatchObject({
                    response: {
                        error: "invalid_proof",
                        error_description: expect.stringContaining(
                            "No wallet provider trust lists configured",
                        ),
                    },
                });
            });

            it("validates the attestation signer against issuer trust", async () => {
                await validate(jwt({ x5c: ["attestation-signer"] }));
                expect(getTrustStore).toHaveBeenCalledWith(
                    expect.objectContaining({ lotes: refs }),
                );
                expect(matchAttestationSigner).toHaveBeenCalledWith(
                    ["attestation-signer"],
                    entities,
                );
            });

            it("rejects an untrusted provider", async () => {
                matchAttestationSigner.mockResolvedValue(null);
                await expect(
                    validate(jwt({ x5c: ["untrusted"] })),
                ).rejects.toMatchObject({
                    response: {
                        error: "invalid_proof",
                        error_description: expect.stringContaining(
                            "signer is not trusted",
                        ),
                    },
                });
            });

            it("rejects missing certificates", async () => {
                await expect(
                    validate(jwt({ jwk: { kty: "EC" } })),
                ).rejects.toMatchObject({
                    response: {
                        error: "invalid_proof",
                        error_description: expect.stringContaining(
                            "must contain an x5c",
                        ),
                    },
                });
            });

            it("rejects unavailable trust lists", async () => {
                getTrustStore.mockRejectedValue(new Error("unavailable"));
                await expect(
                    validate(jwt({ x5c: ["cert"] })),
                ).rejects.toThrow();
            });
        });
    }

    it("allows plain JWT holder proofs without provider trust", async () => {
        await validateJwtProofAttestationTrust(
            jwt({ jwk: { kty: "EC" } }),
            [],
            deps,
        );
        expect(getTrustStore).not.toHaveBeenCalled();
    });

    it("rejects malformed embedded attestations", async () => {
        await expect(
            validateJwtProofAttestationTrust(
                jwt({ key_attestation: {} }),
                refs,
                deps,
            ),
        ).rejects.toMatchObject({
            response: {
                error: "invalid_proof",
                error_description: expect.stringContaining(
                    "must be a compact JWT",
                ),
            },
        });
    });
});

describe("credential proof attestation trust with real certificates", () => {
    const algorithm = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
    const der = (cert: x509.X509Certificate) =>
        Buffer.from(cert.rawData).toString("base64");

    /** A provider CA and a key attestation header chained to it. */
    async function provider() {
        const caKeys = (await crypto.subtle.generateKey(algorithm, true, [
            "sign",
            "verify",
        ])) as CryptoKeyPair;
        const ca = await x509.X509CertificateGenerator.createSelfSigned({
            serialNumber: "01",
            name: "CN=Wallet Provider CA",
            notBefore: new Date(Date.now() - 60_000),
            notAfter: new Date(Date.now() + 3_600_000),
            keys: caKeys,
            signingAlgorithm: algorithm,
            extensions: [new x509.BasicConstraintsExtension(true, 0, true)],
        });
        const leafKeys = (await crypto.subtle.generateKey(algorithm, true, [
            "sign",
            "verify",
        ])) as CryptoKeyPair;
        const leaf = await x509.X509CertificateGenerator.create({
            serialNumber: "02",
            subject: "CN=Key Attestation Signer",
            issuer: ca.subject,
            notBefore: new Date(Date.now() - 60_000),
            notAfter: new Date(Date.now() + 3_600_000),
            publicKey: leafKeys.publicKey,
            signingKey: caKeys.privateKey,
            signingAlgorithm: algorithm,
        });
        return { ca, attestation: jwt({ x5c: [der(leaf)] }) };
    }

    function validate(attestation: string, serviceType: string, ca: string) {
        return validateAttestationProofTrust(
            attestation,
            [{ url: "https://trust.example/list", verifierX509Der: "cert" }],
            {
                trustStoreService: {
                    getTrustStore: async () => ({
                        entities: [
                            {
                                entityId: "provider",
                                services: [
                                    {
                                        serviceTypeIdentifier: serviceType,
                                        certValue: ca,
                                    },
                                ],
                            },
                        ],
                    }),
                } as unknown as TrustStoreService,
                x509ValidationService: new X509ValidationService(),
            },
        );
    }

    it("accepts a signer under a WalletSolution/Issuance certificate", async () => {
        const { ca, attestation } = await provider();

        await expect(
            validate(
                attestation,
                ServiceTypeIdentifiers.WalletSolutionIssuance,
                der(ca),
            ),
        ).resolves.toBeUndefined();
    });

    it("rejects a signer under a certificate listed only as WalletSolution/Revocation", async () => {
        const { ca, attestation } = await provider();

        await expect(
            validate(
                attestation,
                ServiceTypeIdentifiers.WalletSolutionRevocation,
                der(ca),
            ),
        ).rejects.toMatchObject({
            response: {
                error: "invalid_proof",
                error_description: expect.stringContaining(
                    "signer is not trusted",
                ),
            },
        });
    });
});
