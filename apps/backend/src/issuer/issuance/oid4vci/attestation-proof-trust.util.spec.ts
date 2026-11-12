import type { Logger } from "@nestjs/common";
import * as x509 from "@peculiar/x509";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { acceptedSequenceNumbersFake } from "../../../../test/trust/accepted-trust-list-sequence-numbers.fake.js";
import {
    certificateFailure,
    currentPeriod,
    outsideStates,
    periodsOutside,
} from "../../../../test/trust/attestation-certificate-periods.fixture.js";
import type { ValidityPeriod } from "../../../shared/utils/certificate-validity.util.js";
import { CollectTrustedEntities } from "../../../trust/application/collect-trusted-entities.js";
import { TrustStoreService } from "../../../trust/trust-store.service.js";
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
    const warn = vi.fn();
    const deps = {
        tenantId: "tenant-1",
        logger: { warn },
        trustStoreService: { getTrustStore } as unknown as TrustStoreService,
        x509ValidationService: {
            matchAttestationSigner,
        } as unknown as X509ValidationService,
    };
    const entities = [{ services: [] }];

    beforeEach(() => {
        vi.resetAllMocks();
        getTrustStore.mockResolvedValue({ entities, discarded: [] });
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

            it("rejects unavailable trust lists with a fixed answer and logs the reason", async () => {
                getTrustStore.mockRejectedValue(
                    new Error(
                        "Failed to fetch trust list from http://internal/list",
                    ),
                );
                await expect(
                    validate(jwt({ x5c: ["cert"] })),
                ).rejects.toMatchObject({
                    response: {
                        error: "invalid_proof",
                        error_description:
                            "Attestation proof x5c chain could not be validated",
                    },
                });
                expect(warn).toHaveBeenCalledWith(
                    "Key attestation validation failed for tenant tenant-1: Attestation proof x5c chain could not be validated: Failed to fetch trust list from http://internal/list",
                );
            });

            it("logs the reason when the key attestation header cannot be read", async () => {
                await expect(validate("not-a-jwt")).rejects.toMatchObject({
                    response: {
                        error_description:
                            "Attestation proof x5c chain could not be validated",
                    },
                });
                expect(warn).toHaveBeenCalledWith(
                    expect.stringMatching(
                        /^Key attestation validation failed for tenant tenant-1: Attestation proof x5c chain could not be validated: .+/,
                    ),
                );
            });

            it("answers the fixed text for a reference with whitespace-only verifier material, and logs it", async () => {
                const url = "https://internal.example/list";
                await expect(
                    validate(jwt({ x5c: ["cert"] }), [
                        { url, verifierX509Der: "   " },
                    ]),
                ).rejects.toMatchObject({
                    response: {
                        error: "invalid_proof",
                        error_description:
                            "Attestation proof x5c chain could not be validated",
                    },
                });
                expect(getTrustStore).not.toHaveBeenCalled();
                expect(warn).toHaveBeenCalledWith(
                    expect.stringContaining(
                        `Trust list reference '${url}' must define`,
                    ),
                );
            });

            it("counts discarded lists in the fixed answer, names them nowhere, and logs the reason", async () => {
                getTrustStore.mockResolvedValue({
                    entities,
                    discarded: [
                        { list: "http://internal/old", nextUpdate: null },
                    ],
                });
                matchAttestationSigner.mockRejectedValue(new Error("bad cert"));
                const fixed =
                    "Attestation proof x5c chain could not be validated (1 outdated trust list(s) left out; the server log names them)";
                await expect(
                    validate(jwt({ x5c: ["cert"] })),
                ).rejects.toMatchObject({
                    response: {
                        error: "invalid_proof",
                        error_description: fixed,
                    },
                });
                expect(warn).toHaveBeenCalledWith(
                    `Key attestation validation failed for tenant tenant-1: ${fixed}: bad cert`,
                );
            });

            it("logs an unknown reason for a value that is not an Error", async () => {
                getTrustStore.mockRejectedValue("boom");
                await expect(
                    validate(jwt({ x5c: ["cert"] })),
                ).rejects.toThrow();
                expect(warn).toHaveBeenCalledWith(
                    "Key attestation validation failed for tenant tenant-1: Attestation proof x5c chain could not be validated: Unknown error",
                );
            });

            it("does not log a rejection the wallet is told about", async () => {
                matchAttestationSigner.mockResolvedValue(null);
                await expect(
                    validate(jwt({ x5c: ["untrusted"] })),
                ).rejects.toThrow();
                expect(warn).not.toHaveBeenCalled();
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
    async function provider(
        periods: { ca?: ValidityPeriod; leaf?: ValidityPeriod } = {},
    ) {
        const caKeys = (await crypto.subtle.generateKey(algorithm, true, [
            "sign",
            "verify",
        ])) as CryptoKeyPair;
        const ca = await x509.X509CertificateGenerator.createSelfSigned({
            serialNumber: "01",
            name: "CN=Wallet Provider CA",
            ...(periods.ca ?? currentPeriod()),
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
            ...(periods.leaf ?? currentPeriod()),
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
                        discarded: [],
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
        ).resolves.toMatchObject({
            matchedEntity: expect.any(Object),
            trustStore: expect.any(Object),
            certificates: [expect.any(String)],
        });
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

    describe("with a certificate outside its validity period", () => {
        const positions = { leaf: "Signing", ca: "Trust list" } as const;

        for (const state of outsideStates) {
            for (const cert of ["leaf", "ca"] as const) {
                it(`rejects with invalid_proof a key attestation whose ${cert === "leaf" ? "signing certificate" : "WalletSolution/Issuance CA"} is ${state}`, async () => {
                    const { ca, attestation } = await provider({
                        [cert]: periodsOutside[state](),
                    });

                    await expect(
                        validate(
                            attestation,
                            ServiceTypeIdentifiers.WalletSolutionIssuance,
                            der(ca),
                        ),
                    ).rejects.toMatchObject({
                        response: {
                            error: "invalid_proof",
                            error_description: expect.stringContaining(
                                `Attestation proof certificate chain is not valid: ${certificateFailure(positions[cert], state)}`,
                            ),
                        },
                    });
                });
            }
        }
    });

    // A replayed older provider list keeps its valid signature; its passed
    // NextUpdate discards it (ETSI TS 119 602 §6.3.15), the other lists count.
    describe("with an outdated wallet-provider list", () => {
        const day = 86_400_000;
        const current = () => new Date(Date.now() + day).toISOString();
        const outdated = () => new Date(Date.now() - day).toISOString();

        async function validateWith(
            lists: Array<{ withProvider: boolean; nextUpdate: string }>,
        ) {
            const { ca, attestation } = await provider();
            const providerEntity = {
                entityId: "provider",
                services: [
                    {
                        serviceTypeIdentifier:
                            ServiceTypeIdentifiers.WalletSolutionIssuance,
                        certValue: der(ca),
                    },
                ],
            };
            const otherEntity = {
                entityId: "other provider",
                services: [
                    {
                        serviceTypeIdentifier:
                            ServiceTypeIdentifiers.WalletSolutionIssuance,
                        certValue: der((await provider()).ca),
                    },
                ],
            };
            const loadVerified = vi.fn();
            for (const list of lists) {
                loadVerified.mockResolvedValueOnce({
                    // Without the provider, the list names another one.
                    entities: [
                        list.withProvider ? providerEntity : otherEntity,
                    ],
                    nextUpdate: list.nextUpdate,
                    sequenceNumber: 1,
                });
            }
            const noNumbers = acceptedSequenceNumbersFake();
            const trustStoreService = new TrustStoreService(
                new CollectTrustedEntities({ loadVerified }, noNumbers),
                {} as never,
                {} as never,
                {} as never,
                noNumbers,
            );
            vi.spyOn(
                (trustStoreService as unknown as { logger: Logger }).logger,
                "warn",
            ).mockImplementation(() => {});
            return validateAttestationProofTrust(
                attestation,
                lists.map((_, i) => ({
                    url: `https://trust.example/list-${i}`,
                    verifierX509Der: "MII",
                })),
                {
                    tenantId: "tenant-1",
                    logger: { warn },
                    trustStoreService,
                    x509ValidationService: new X509ValidationService(),
                },
            );
        }

        const warn = vi.fn();
        beforeEach(() => warn.mockReset());

        it("accepts a provider in a current list next to an outdated one", async () => {
            await expect(
                validateWith([
                    { withProvider: true, nextUpdate: current() },
                    { withProvider: true, nextUpdate: outdated() },
                ]),
            ).resolves.toMatchObject({ matchedEntity: expect.any(Object) });
        });

        it("rejects with invalid_proof a provider listed only in the outdated list, and says lists were left out", async () => {
            await expect(
                validateWith([
                    { withProvider: false, nextUpdate: current() },
                    { withProvider: true, nextUpdate: outdated() },
                ]),
            ).rejects.toMatchObject({
                response: {
                    error: "invalid_proof",
                    error_description:
                        "Attestation proof signer is not trusted by configured wallet provider trust lists (1 outdated trust list(s) left out; the server log names them)",
                },
            });
        });

        it("rejects with invalid_proof when every list is outdated, and says so", async () => {
            await expect(
                validateWith([
                    { withProvider: true, nextUpdate: outdated() },
                    { withProvider: true, nextUpdate: outdated() },
                ]),
            ).rejects.toMatchObject({
                response: {
                    error: "invalid_proof",
                    error_description:
                        "No configured trust list is current: each has no valid NextUpdate or one that has passed, no valid LoTESequenceNumber, or a lower one than a list accepted before",
                },
            });
            expect(warn).toHaveBeenCalledWith(
                "Key attestation validation failed for tenant tenant-1: No configured trust list is current: each has no valid NextUpdate or one that has passed, no valid LoTESequenceNumber, or a lower one than a list accepted before",
            );
        });
    });
});
