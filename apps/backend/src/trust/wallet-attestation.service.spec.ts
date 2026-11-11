import { type Logger, UnauthorizedException } from "@nestjs/common";
import { ES256 } from "@owf/crypto";
import * as x509 from "@peculiar/x509";
import { describe, expect, it, vi } from "vitest";
import { acceptedSequenceNumbersFake } from "../../test/trust/accepted-trust-list-sequence-numbers.fake.js";
import { CollectTrustedEntities } from "./application/collect-trusted-entities.js";
import { AttestationStatusRejected } from "./domain/attestation-status-rejected.js";
import { OutdatedTrustListsError } from "./domain/trust-list-freshness.js";
import { RevocationListUnavailableError } from "./revocation-policy.util.js";
import {
    InvalidStatusListTokenError,
    StatusListIndexOutOfRange,
} from "./status-list-verifier.service.js";
import { TrustStoreService } from "./trust-store.service.js";
import {
    RevocationCheckMode,
    ServiceTypeIdentifiers,
    type TrustListRef,
} from "./types.js";
import { WalletAttestationService } from "./wallet-attestation.service.js";
import {
    MatchedTrustedEntity,
    X509ValidationService,
} from "./x509-validation.service.js";

describe("WalletAttestationService trust requirements", () => {
    function createService() {
        return Object.assign(
            Object.create(WalletAttestationService.prototype),
            {
                getIssuer: () => ({ verifyWalletAttestation: vi.fn() }),
                settings: { cryptoToleranceSeconds: 0 },
            },
        ) as WalletAttestationService;
    }

    it("allows an absent optional attestation", async () => {
        await expect(
            createService().verifyWalletAttestation(
                "tenant",
                undefined,
                "https://as.example",
                false,
                [],
                RevocationCheckMode.Strict,
            ),
        ).resolves.toBeUndefined();
    });

    it("rejects an absent required attestation", async () => {
        await expect(
            createService().verifyWalletAttestation(
                "tenant",
                undefined,
                "https://as.example",
                true,
                [],
                RevocationCheckMode.Strict,
            ),
        ).rejects.toThrow("required but not provided");
    });

    it.each([true, false])(
        "requires provider trust for a presented attestation (required=%s)",
        async (required) => {
            await expect(
                createService().verifyWalletAttestation(
                    "tenant",
                    {
                        clientAttestationJwt: "signed-attestation",
                        clientAttestationPopJwt: "signed-pop",
                    },
                    "https://as.example",
                    required,
                    [],
                    RevocationCheckMode.Strict,
                ),
            ).rejects.toThrow("No wallet provider trust lists configured");
        },
    );
});

// The built-in token endpoint returns the message as error_description, so
// it reaches the wallet. Server-side reasons name trust list URLs, including
// INTERNAL_URL for managed lists, and are only the cause, which callers log.
describe("WalletAttestationService error messages for the wallet", () => {
    const internalListUrl =
        "http://eudiplo-internal:3000/issuers/tenant/trust-list/wallets";
    const attestationJwt = `${Buffer.from(
        JSON.stringify({ alg: "ES256", x5c: ["MII"] }),
    ).toString("base64url")}.e30.c2ln`;

    function createService(options: {
        verifyAttestation?: () => Promise<void>;
        getTrustStore?: () => Promise<unknown>;
    }) {
        return Object.assign(
            Object.create(WalletAttestationService.prototype),
            {
                getIssuer: () => ({
                    verifyWalletAttestation:
                        options.verifyAttestation ?? vi.fn(),
                }),
                settings: { cryptoToleranceSeconds: 0 },
                logger: { debug: vi.fn() },
                trustStoreService: {
                    getTrustStore:
                        options.getTrustStore ??
                        (() => Promise.reject(new Error("not reached"))),
                },
            },
        ) as WalletAttestationService;
    }

    function verify(
        service: WalletAttestationService,
        trustLists: TrustListRef[] = [
            { url: internalListUrl, verifierX509Der: "MII" },
        ],
    ): Promise<Error | undefined> {
        return service
            .verifyWalletAttestation(
                "tenant",
                {
                    clientAttestationJwt: attestationJwt,
                    clientAttestationPopJwt: "pop",
                },
                "https://as.example",
                true,
                trustLists,
                RevocationCheckMode.Disabled,
            )
            .then(
                () => undefined,
                (error: Error) => error,
            );
    }

    it.each([
        `Failed to fetch trust list from ${internalListUrl}: connect ECONNREFUSED 10.0.0.7:3000`,
        `Trust list JWT verification failed for ${internalListUrl}: signature verification failed`,
    ])(
        "answers a fixed message when a trust list cannot be loaded (%s)",
        async (reason) => {
            const service = createService({
                getTrustStore: () => Promise.reject(new Error(reason)),
            });

            const error = await verify(service);

            expect(error).toBeInstanceOf(UnauthorizedException);
            expect(error?.message).toBe(
                "Wallet provider trust lists could not be loaded",
            );
            expect((error?.cause as Error).message).toBe(reason);
        },
    );

    it("answers a fixed message for other server-side errors and keeps the reason as cause", async () => {
        const service = createService({});

        // A reference without verification material names its URL.
        const error = await verify(service, [{ url: internalListUrl }]);

        expect(error).toBeInstanceOf(UnauthorizedException);
        expect(error?.message).toBe("Wallet attestation verification failed");
        expect((error?.cause as Error).message).toContain(internalListUrl);
    });

    it("keeps the reason when the attestation the wallet sent is invalid", async () => {
        const service = createService({
            verifyAttestation: () =>
                Promise.reject(new Error("Client attestation jwt has expired")),
        });

        const error = await verify(service);

        expect(error).toBeInstanceOf(UnauthorizedException);
        expect(error?.message).toBe(
            "Wallet attestation verification failed: Client attestation jwt has expired",
        );
    });

    it("keeps the reason when every trust list is outdated", async () => {
        const service = createService({
            getTrustStore: () =>
                Promise.reject(
                    new OutdatedTrustListsError([
                        { list: internalListUrl, nextUpdate: null },
                    ]),
                ),
        });

        const error = await verify(service);

        expect(error).toBeInstanceOf(UnauthorizedException);
        expect(error?.message).toBe(
            "Wallet attestation verification failed: No configured trust list is current: each has no valid NextUpdate or one that has passed, no valid LoTESequenceNumber, or a lower one than a list accepted before",
        );
    });
});

describe("WalletAttestationService status list signature", () => {
    const algorithm = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
    const b64url = (input: string | ArrayBuffer) =>
        Buffer.from(
            typeof input === "string" ? input : new Uint8Array(input),
        ).toString("base64url");

    /** Status list JWT whose x5c holds a genuine certificate for the signing key. */
    async function signedStatusList() {
        const keys = (await crypto.subtle.generateKey(algorithm, true, [
            "sign",
            "verify",
        ])) as CryptoKeyPair;
        const cert = await x509.X509CertificateGenerator.createSelfSigned({
            serialNumber: "01",
            name: "CN=Status List Signer",
            notBefore: new Date(Date.now() - 60_000),
            notAfter: new Date(Date.now() + 3_600_000),
            keys,
            signingAlgorithm: algorithm,
        });
        const header = b64url(
            JSON.stringify({
                alg: "ES256",
                typ: "statuslist+jwt",
                x5c: [Buffer.from(cert.rawData).toString("base64")],
            }),
        );
        const payload = (lst: string) =>
            b64url(JSON.stringify({ status_list: { bits: 1, lst } }));
        const data = `${header}.${payload("AA")}`;
        const signature = b64url(
            await crypto.subtle.sign(
                algorithm,
                keys.privateKey,
                new TextEncoder().encode(data),
            ),
        );
        return {
            jwt: `${data}.${signature}`,
            forgedJwt: `${header}.${payload("AQ")}.${signature}`,
        };
    }

    function verifyStatusListSignature(
        jwt: string,
        cryptoImpl: unknown = ES256,
    ): Promise<boolean> {
        const service = Object.assign(
            Object.create(WalletAttestationService.prototype),
            {
                logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
                cryptoImplementationService: {
                    getCryptoFromJwk: () => cryptoImpl,
                },
            },
        );
        return service.verifyStatusListSignature(jwt, null, null);
    }

    it("accepts a correctly signed status list", async () => {
        const { jwt } = await signedStatusList();

        await expect(verifyStatusListSignature(jwt)).resolves.toBe(true);
    });

    it("rejects a forged payload signed for a genuine x5c", async () => {
        const { forgedJwt } = await signedStatusList();

        await expect(verifyStatusListSignature(forgedJwt)).resolves.toBe(false);
    });

    it("rejects the status list when the signature cannot be checked", async () => {
        const { jwt } = await signedStatusList();
        const throwingCrypto = {
            getVerifier: async () => async () => {
                throw new Error("unsupported key");
            },
        };

        await expect(
            verifyStatusListSignature(jwt, throwingCrypto),
        ).resolves.toBe(false);
    });
});

describe("WalletAttestationService status list signer", () => {
    const algorithm = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
    const b64url = (input: string | ArrayBuffer) =>
        Buffer.from(
            typeof input === "string" ? input : new Uint8Array(input),
        ).toString("base64url");
    const der = (cert: x509.X509Certificate) =>
        Buffer.from(cert.rawData).toString("base64");

    async function keys() {
        return (await crypto.subtle.generateKey(algorithm, true, [
            "sign",
            "verify",
        ])) as CryptoKeyPair;
    }

    async function ca(name: string) {
        const caKeys = await keys();
        const cert = await x509.X509CertificateGenerator.createSelfSigned({
            serialNumber: "01",
            name: `CN=${name}`,
            notBefore: new Date(Date.now() - 60_000),
            notAfter: new Date(Date.now() + 3_600_000),
            keys: caKeys,
            signingAlgorithm: algorithm,
            extensions: [new x509.BasicConstraintsExtension(true, 0, true)],
        });
        return { cert, keys: caKeys };
    }

    /** Status list JWT signed by a leaf certificate that `issuer` issued. */
    async function statusListUnder(issuer: Awaited<ReturnType<typeof ca>>) {
        const leafKeys = await keys();
        const leaf = await x509.X509CertificateGenerator.create({
            serialNumber: "02",
            subject: "CN=Status List Signer",
            issuer: issuer.cert.subject,
            notBefore: new Date(Date.now() - 60_000),
            notAfter: new Date(Date.now() + 3_600_000),
            publicKey: leafKeys.publicKey,
            signingKey: issuer.keys.privateKey,
            signingAlgorithm: algorithm,
        });
        const data = `${b64url(
            JSON.stringify({
                alg: "ES256",
                typ: "statuslist+jwt",
                x5c: [der(leaf)],
            }),
        )}.${b64url(JSON.stringify({ status_list: { bits: 1, lst: "AA" } }))}`;
        const signature = b64url(
            await crypto.subtle.sign(
                algorithm,
                leafKeys.privateKey,
                new TextEncoder().encode(data),
            ),
        );
        return `${data}.${signature}`;
    }

    /** Verify with the provider CA and `otherCa` both in the trust store. */
    async function verify(
        jwt: string,
        providerCa: x509.X509Certificate,
        otherCa: x509.X509Certificate,
    ) {
        const issuanceThumbprint = Buffer.from(
            await providerCa.getThumbprint("SHA-256"),
        ).toString("hex");
        const matchedEntity: MatchedTrustedEntity = {
            entity: { entityId: "provider", services: [] },
            issuanceCert: providerCa,
            issuanceThumbprint,
            issuanceIsCa: true,
            issuanceServiceType: ServiceTypeIdentifiers.WalletSolutionIssuance,
            matchMode: "ca",
        };
        const service = Object.assign(
            Object.create(WalletAttestationService.prototype),
            {
                logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
                cryptoImplementationService: {
                    getCryptoFromJwk: () => ES256,
                },
                x509ValidationService: new X509ValidationService(),
            },
        );
        return service.verifyStatusListSignature(jwt, matchedEntity, {
            entities: [
                {
                    services: [
                        { certValue: der(providerCa) },
                        { certValue: der(otherCa) },
                    ],
                },
            ],
        });
    }

    it("accepts a status list chained to the provider's attestation CA", async () => {
        const providerCa = await ca("Provider CA");
        const otherCa = await ca("Other Provider CA");

        await expect(
            verify(
                await statusListUnder(providerCa),
                providerCa.cert,
                otherCa.cert,
            ),
        ).resolves.toBe(true);
    });

    /**
     * A provider whose attestation and revocation CAs share subject and key
     * (two key chains imported with one private key): a leaf signed with
     * that key verifies under both, so the path must end at the revocation
     * CA the check expects, whatever the order in the trust store.
     */
    for (const order of [
        "attestation CA first",
        "revocation CA first",
    ] as const) {
        it(`accepts a status list under a revocation CA that shares subject and key with the attestation CA (${order})`, async () => {
            const attestationCa = await ca("Provider Root CA");
            const revocationCert =
                await x509.X509CertificateGenerator.createSelfSigned({
                    serialNumber: "03",
                    name: "CN=Provider Root CA",
                    notBefore: new Date(Date.now() - 60_000),
                    notAfter: new Date(Date.now() + 3_600_000),
                    keys: attestationCa.keys,
                    signingAlgorithm: algorithm,
                    extensions: [
                        new x509.BasicConstraintsExtension(true, 0, true),
                    ],
                });
            const revocationCa = {
                cert: revocationCert,
                keys: attestationCa.keys,
            };
            const thumb = async (cert: x509.X509Certificate) =>
                Buffer.from(await cert.getThumbprint("SHA-256")).toString(
                    "hex",
                );
            const services = [
                {
                    serviceTypeIdentifier:
                        ServiceTypeIdentifiers.WalletSolutionIssuance,
                    certValue: der(attestationCa.cert),
                },
                {
                    serviceTypeIdentifier:
                        ServiceTypeIdentifiers.WalletSolutionRevocation,
                    certValue: der(revocationCa.cert),
                },
            ];
            const matchedEntity: MatchedTrustedEntity = {
                entity: { entityId: "provider", services },
                issuanceCert: attestationCa.cert,
                issuanceThumbprint: await thumb(attestationCa.cert),
                issuanceIsCa: true,
                issuanceServiceType:
                    ServiceTypeIdentifiers.WalletSolutionIssuance,
                matchMode: "ca",
            };
            const service = Object.assign(
                Object.create(WalletAttestationService.prototype),
                {
                    logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
                    cryptoImplementationService: {
                        getCryptoFromJwk: () => ES256,
                    },
                    x509ValidationService: new X509ValidationService(),
                },
            );

            await expect(
                service.verifyStatusListSignature(
                    await statusListUnder(revocationCa),
                    matchedEntity,
                    {
                        entities: [
                            {
                                services:
                                    order === "attestation CA first"
                                        ? services
                                        : [...services].reverse(),
                            },
                        ],
                    },
                ),
            ).resolves.toBe(true);
        });
    }

    /** Verify against a provider that lists `revocationCas` as revocation services. */
    async function verifyWithRevocation(
        jwt: string,
        attestationCa: x509.X509Certificate,
        revocationCas: x509.X509Certificate[],
    ) {
        const services = [
            {
                serviceTypeIdentifier:
                    ServiceTypeIdentifiers.WalletSolutionIssuance,
                certValue: der(attestationCa),
            },
            ...revocationCas.map((cert) => ({
                serviceTypeIdentifier:
                    ServiceTypeIdentifiers.WalletSolutionRevocation,
                certValue: der(cert),
            })),
        ];
        const matchedEntity: MatchedTrustedEntity = {
            entity: { entityId: "provider", services },
            issuanceCert: attestationCa,
            issuanceThumbprint: Buffer.from(
                await attestationCa.getThumbprint("SHA-256"),
            ).toString("hex"),
            issuanceIsCa: true,
            issuanceServiceType: ServiceTypeIdentifiers.WalletSolutionIssuance,
            matchMode: "ca",
        };
        const service = Object.assign(
            Object.create(WalletAttestationService.prototype),
            {
                logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
                cryptoImplementationService: {
                    getCryptoFromJwk: () => ES256,
                },
                x509ValidationService: new X509ValidationService(),
            },
        );
        return service.verifyStatusListSignature(jwt, matchedEntity, {
            entities: [matchedEntity.entity],
        });
    }

    it("accepts a status list under any revocation CA of the provider", async () => {
        const attestationCa = await ca("Provider CA");
        const firstRevocationCa = await ca("Provider Status CA 1");
        const secondRevocationCa = await ca("Provider Status CA 2");

        await expect(
            verifyWithRevocation(
                await statusListUnder(secondRevocationCa),
                attestationCa.cert,
                [firstRevocationCa.cert, secondRevocationCa.cert],
            ),
        ).resolves.toBe(true);
    });

    it("rejects a status list under the attestation CA when the provider lists a revocation CA", async () => {
        const attestationCa = await ca("Provider CA");
        const revocationCa = await ca("Provider Status CA");

        await expect(
            verifyWithRevocation(
                await statusListUnder(attestationCa),
                attestationCa.cert,
                [revocationCa.cert],
            ),
        ).resolves.toBe(false);
    });

    it("rejects a status list chained to another CA in the trust store", async () => {
        const providerCa = await ca("Provider CA");
        const otherCa = await ca("Foreign CA");

        await expect(
            verify(
                await statusListUnder(otherCa),
                providerCa.cert,
                otherCa.cert,
            ),
        ).resolves.toBe(false);
    });
});

describe("WalletAttestationService status check mode", () => {
    const statusEntry = { uri: "https://wp.example/status", idx: 3 };

    /** Service whose status list fetch fails with `fetchError`, or returns a list read with `readStatus`. */
    function createService(options: {
        fetchError?: Error;
        readStatus?: () => { isValid: boolean; description: string };
        malformedStatusClaim?: boolean;
    }) {
        const statusListVerifierService = {
            getStatusEntryFromJwt: vi.fn(() => {
                if (options.malformedStatusClaim) {
                    throw new Error("The status_list claim has no uri");
                }
                return statusEntry;
            }),
            getStatusListJwt: vi.fn(async () => {
                if (options.fetchError) throw options.fetchError;
                return "status-list-jwt";
            }),
            getStatusFromStatusListJwt: vi.fn(
                options.readStatus ??
                    (() => ({ isValid: true, description: "VALID" })),
            ),
        };
        const service = Object.assign(
            Object.create(WalletAttestationService.prototype),
            {
                logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
                statusListVerifierService,
                settings: { cryptoToleranceSeconds: 0 },
                verifyStatusListSignature: vi.fn(async () => true),
            },
        );
        return { service, statusListVerifierService };
    }

    const check = (
        service: unknown,
        mode: RevocationCheckMode,
    ): Promise<unknown> =>
        (
            service as {
                validateAttestationStatus(
                    tenantId: string,
                    jwt: string,
                    entity: null,
                    store: null,
                    mode: RevocationCheckMode,
                ): Promise<unknown>;
            }
        ).validateAttestationStatus(
            "tenant-a",
            "attestation",
            null,
            null,
            mode,
        );

    const unavailable = () =>
        new RevocationListUnavailableError(
            "Failed to fetch status list from https://wp.example/status: timeout",
        );
    const outOfRange = () => {
        throw new Error("Index 3 out of bounds");
    };

    it("strict rejects a status list that cannot be fetched", async () => {
        const { service } = createService({ fetchError: unavailable() });

        await expect(
            check(service, RevocationCheckMode.Strict),
        ).rejects.toThrow("Wallet attestation status check failed");
    });

    it("best_effort accepts a status list that cannot be fetched", async () => {
        const { service } = createService({ fetchError: unavailable() });

        await expect(
            check(service, RevocationCheckMode.BestEffort),
        ).resolves.toEqual(statusEntry);
    });

    it.each([RevocationCheckMode.Strict, RevocationCheckMode.BestEffort])(
        "%s rejects an unreadable status list",
        async (mode) => {
            const { service } = createService({
                fetchError: new TypeError("Expected a status list JWT"),
            });

            await expect(check(service, mode)).rejects.toThrow(
                "Wallet attestation status check failed",
            );
        },
    );

    it.each([RevocationCheckMode.Strict, RevocationCheckMode.BestEffort])(
        "%s rejects an index outside the status list",
        async (mode) => {
            const { service } = createService({ readStatus: outOfRange });

            await expect(check(service, mode)).rejects.toThrow(
                "Wallet attestation status list rejected: Index 3 out of bounds",
            );
        },
    );

    it.each([RevocationCheckMode.Strict, RevocationCheckMode.BestEffort])(
        "%s rejects a malformed status claim",
        async (mode) => {
            const { service, statusListVerifierService } = createService({
                malformedStatusClaim: true,
            });

            await expect(check(service, mode)).rejects.toThrow(
                /^Wallet attestation status check failed$/,
            );
            expect(
                statusListVerifierService.getStatusListJwt,
            ).not.toHaveBeenCalled();
        },
    );

    it("disabled does not read a malformed status claim", async () => {
        const { service } = createService({ malformedStatusClaim: true });

        await expect(
            check(service, RevocationCheckMode.Disabled),
        ).resolves.toBeUndefined();
    });

    it.each([RevocationCheckMode.Strict, RevocationCheckMode.BestEffort])(
        "%s rejects a revoked attestation",
        async (mode) => {
            const { service } = createService({
                readStatus: () => ({ isValid: false, description: "INVALID" }),
            });

            await expect(check(service, mode)).rejects.toThrow(
                "Wallet attestation is not valid: INVALID",
            );
        },
    );

    it("does not return the failure reason to the wallet", async () => {
        const { service } = createService({ fetchError: unavailable() });

        await expect(
            check(service, RevocationCheckMode.Strict),
        ).rejects.toThrow(/^Wallet attestation status check failed$/);
    });

    it.each([RevocationCheckMode.Strict, RevocationCheckMode.BestEffort])(
        "%s rejects when the signature check throws",
        async (mode) => {
            const { service } = createService({});
            service.verifyStatusListSignature = vi.fn(async () => {
                throw new Error("unsupported key");
            });

            await expect(check(service, mode)).rejects.toThrow(
                "Wallet attestation status check failed",
            );
        },
    );

    it("disabled skips the status check", async () => {
        const { service, statusListVerifierService } = createService({
            readStatus: () => ({ isValid: false, description: "INVALID" }),
        });

        await expect(
            check(service, RevocationCheckMode.Disabled),
        ).resolves.toEqual(statusEntry);
        expect(
            statusListVerifierService.getStatusListJwt,
        ).not.toHaveBeenCalled();
    });

    describe("of key attestations", () => {
        const checkKey = (
            service: WalletAttestationService,
            mode: RevocationCheckMode,
        ) =>
            service.checkKeyAttestationStatus(
                "tenant-a",
                "key-attestation",
                {} as never,
                {} as never,
                mode,
            );

        it("returns the status list reference of a valid key attestation", async () => {
            const { service, statusListVerifierService } = createService({});

            await expect(
                checkKey(service, RevocationCheckMode.Strict),
            ).resolves.toEqual(statusEntry);
            // Fetched for the tenant the key attestation was presented to.
            expect(
                statusListVerifierService.getStatusListJwt,
            ).toHaveBeenCalledWith(statusEntry.uri, "tenant-a");
        });

        it.each([RevocationCheckMode.Strict, RevocationCheckMode.BestEffort])(
            "%s rejects a revoked key attestation with a key attestation message",
            async (mode) => {
                const { service } = createService({
                    readStatus: () => ({
                        isValid: false,
                        description: "INVALID",
                    }),
                });

                const error = await checkKey(service, mode).catch((e) => e);
                expect(error).toBeInstanceOf(AttestationStatusRejected);
                expect(error.message).toBe(
                    "Key attestation is not valid: INVALID",
                );
            },
        );

        it("hides why the status list could not be fetched", async () => {
            const { service } = createService({ fetchError: unavailable() });

            const error = await checkKey(
                service,
                RevocationCheckMode.Strict,
            ).catch((e) => e);
            expect(error).toBeInstanceOf(AttestationStatusRejected);
            expect(error.message).toBe("Key attestation status check failed");
            expect(error.cause.message).toContain("timeout");
        });

        it("returns no reference for a malformed claim when the check is disabled", async () => {
            const { service } = createService({ malformedStatusClaim: true });

            await expect(
                checkKey(service, RevocationCheckMode.Disabled),
            ).resolves.toBeUndefined();
        });

        it("returns the reference when the check is disabled", async () => {
            const { service, statusListVerifierService } = createService({
                readStatus: () => ({ isValid: false, description: "INVALID" }),
            });

            await expect(
                checkKey(service, RevocationCheckMode.Disabled),
            ).resolves.toEqual(statusEntry);
            expect(
                statusListVerifierService.getStatusListJwt,
            ).not.toHaveBeenCalled();
        });
    });
});

describe("WalletAttestationService wallet attestation signer", () => {
    const algorithm = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
    const der = (cert: x509.X509Certificate) =>
        Buffer.from(cert.rawData).toString("base64");

    async function keys() {
        return (await crypto.subtle.generateKey(algorithm, true, [
            "sign",
            "verify",
        ])) as CryptoKeyPair;
    }

    function selfSignedCa(serialNumber: string, caKeys: CryptoKeyPair) {
        return x509.X509CertificateGenerator.createSelfSigned({
            serialNumber,
            name: "CN=Wallet Provider Root CA",
            notBefore: new Date(Date.now() - 60_000),
            notAfter: new Date(Date.now() + 3_600_000),
            keys: caKeys,
            signingAlgorithm: algorithm,
            extensions: [new x509.BasicConstraintsExtension(true, 0, true)],
        });
    }

    /**
     * A provider whose attestation CA and revocation CA share subject and
     * key, and a wallet attestation signed below them. Only the header is
     * read here; signatures are checked elsewhere.
     */
    async function provider() {
        const caKeys = await keys();
        const attestationCa = await selfSignedCa("01", caKeys);
        const revocationCa = await selfSignedCa("02", caKeys);
        const leafKeys = await keys();
        const leaf = await x509.X509CertificateGenerator.create({
            serialNumber: "03",
            subject: "CN=Wallet Attestation Signer",
            issuer: attestationCa.subject,
            notBefore: new Date(Date.now() - 60_000),
            notAfter: new Date(Date.now() + 3_600_000),
            publicKey: leafKeys.publicKey,
            signingKey: caKeys.privateKey,
            signingAlgorithm: algorithm,
        });
        const header = Buffer.from(
            JSON.stringify({ alg: "ES256", x5c: [der(leaf)] }),
        ).toString("base64url");
        return { attestationCa, revocationCa, jwt: `${header}.e30.c2ln` };
    }

    function validate(
        jwt: string,
        services: Array<{ serviceTypeIdentifier: string; certValue: string }>,
    ) {
        const service = Object.assign(
            Object.create(WalletAttestationService.prototype),
            {
                logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
                trustStoreService: {
                    getTrustStore: async () => ({
                        entities: [{ entityId: "provider", services }],
                        discarded: [],
                    }),
                },
                x509ValidationService: new X509ValidationService(),
            },
        );
        return service.validateWalletSolutionCertificate(
            jwt,
            [{ url: "https://trust.example/wallets", verifierX509Der: "MII" }],
            "tenant",
        );
    }

    for (const order of [
        "attestation CA first",
        "revocation CA first",
    ] as const) {
        it(`accepts an attestation under the attestation CA when a revocation CA shares subject and key (${order})`, async () => {
            const { attestationCa, revocationCa, jwt } = await provider();
            const services = [
                {
                    serviceTypeIdentifier:
                        ServiceTypeIdentifiers.WalletSolutionIssuance,
                    certValue: der(attestationCa),
                },
                {
                    serviceTypeIdentifier:
                        ServiceTypeIdentifiers.WalletSolutionRevocation,
                    certValue: der(revocationCa),
                },
            ];

            const { matchedEntity } = await validate(
                jwt,
                order === "attestation CA first"
                    ? services
                    : [...services].reverse(),
            );

            expect(matchedEntity?.issuanceThumbprint).toBe(
                Buffer.from(
                    await attestationCa.getThumbprint("SHA-256"),
                ).toString("hex"),
            );
        });
    }

    it("rejects an attestation under a CA listed only as WalletSolution/Revocation", async () => {
        const { attestationCa, jwt } = await provider();

        await expect(
            validate(jwt, [
                {
                    serviceTypeIdentifier:
                        ServiceTypeIdentifiers.WalletSolutionRevocation,
                    certValue: der(attestationCa),
                },
            ]),
        ).rejects.toThrow("Wallet provider certificate is not trusted");
    });

    // A replayed older provider list keeps its valid signature; its passed
    // NextUpdate discards it (ETSI TS 119 602 §6.3.15), the other lists count.
    describe("with an outdated wallet-provider list", () => {
        const day = 86_400_000;
        const current = () => new Date(Date.now() + day).toISOString();
        const outdated = () => new Date(Date.now() - day).toISOString();

        async function verifyWith(
            lists: Array<{ withProvider: boolean; nextUpdate: string }>,
        ) {
            const { attestationCa, jwt } = await provider();
            const providerEntity = {
                entityId: "provider",
                services: [
                    {
                        serviceTypeIdentifier:
                            ServiceTypeIdentifiers.WalletSolutionIssuance,
                        certValue: der(attestationCa),
                    },
                ],
            };
            const otherEntity = {
                entityId: "other provider",
                services: [
                    {
                        serviceTypeIdentifier:
                            ServiceTypeIdentifiers.WalletSolutionIssuance,
                        certValue: der((await provider()).attestationCa),
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
            return (
                Object.assign(
                    Object.create(WalletAttestationService.prototype),
                    {
                        getIssuer: () => ({ verifyWalletAttestation: vi.fn() }),
                        settings: { cryptoToleranceSeconds: 0 },
                        logger: { debug: vi.fn(), warn: vi.fn() },
                        trustStoreService,
                        x509ValidationService: new X509ValidationService(),
                    },
                ) as WalletAttestationService
            ).verifyWalletAttestation(
                "tenant",
                { clientAttestationJwt: jwt, clientAttestationPopJwt: "pop" },
                "https://as.example",
                true,
                lists.map((_, i) => ({
                    url: `https://trust.example/list-${i}`,
                    verifierX509Der: "MII",
                })),
                // The attestation has no status claim; only provider trust is under test.
                RevocationCheckMode.Disabled,
            );
        }

        it("accepts a provider in a current list next to an outdated one", async () => {
            await expect(
                verifyWith([
                    { withProvider: true, nextUpdate: current() },
                    { withProvider: true, nextUpdate: outdated() },
                ]),
            ).resolves.toBeUndefined();
        });

        it("rejects with 401 a provider listed only in the outdated list, and says lists were left out", async () => {
            const rejected = verifyWith([
                { withProvider: false, nextUpdate: current() },
                { withProvider: true, nextUpdate: outdated() },
            ]);
            await expect(rejected).rejects.toBeInstanceOf(
                UnauthorizedException,
            );
            await expect(rejected).rejects.toThrow(
                "Wallet provider certificate is not trusted - no matching entity in trust list (1 outdated trust list(s) left out; the server log names them)",
            );
            // The answer goes to the wallet; only the log names the list.
            await expect(rejected).rejects.not.toThrow("trust.example");
        });

        it("rejects with 401 when every list is outdated", async () => {
            const rejected = verifyWith([
                { withProvider: true, nextUpdate: outdated() },
                { withProvider: true, nextUpdate: outdated() },
            ]);
            await expect(rejected).rejects.toBeInstanceOf(
                UnauthorizedException,
            );
            await expect(rejected).rejects.toThrow(
                "No configured trust list is current",
            );
        });
    });
});

describe("WalletAttestationService wallet unit status", () => {
    const uri = "https://wp.example/wua-status";
    const trustLists = [{ trustListId: "providers", url: "" }];
    const provider = { entity: { entityId: "wp" } };

    function createService(options: {
        matched?: boolean;
        signatureValid?: boolean;
        statuses?: Record<number, number | Error>;
    }) {
        const getTrustStore = vi.fn(async () => ({
            entities: [{ entityId: "wp" }],
            discarded: [],
        }));
        const matchAttestationSigner = vi.fn(async () =>
            options.matched === false ? null : provider,
        );
        const getStatusListJwt = vi.fn(async () => "status-list-jwt");
        const getStatusFromStatusListJwt = vi.fn(
            (_jwt: string, entry: { idx: number }) => {
                const status = options.statuses?.[entry.idx] ?? 0;
                if (status instanceof Error) throw status;
                return { status, isValid: status === 0, description: "" };
            },
        );
        const verifyStatusListSignature = vi.fn(
            async () => options.signatureValid !== false,
        );
        const service = Object.assign(
            Object.create(WalletAttestationService.prototype),
            {
                logger: { warn: vi.fn(), debug: vi.fn() },
                trustStoreService: { getTrustStore },
                x509ValidationService: { matchAttestationSigner },
                statusListVerifierService: {
                    getStatusListJwt,
                    getStatusFromStatusListJwt,
                },
                settings: { cryptoToleranceSeconds: 5 },
                verifyStatusListSignature,
            },
        ) as WalletAttestationService;
        return {
            service,
            getStatusListJwt,
            matchAttestationSigner,
            getStatusFromStatusListJwt,
            verifyStatusListSignature,
        };
    }

    const read = (service: WalletAttestationService, indexes: number[]) =>
        service.readWalletUnitStatuses(
            "tenant",
            ["leaf"],
            uri,
            indexes,
            trustLists,
        );

    it("verifies the list once against the matched provider and reads every index", async () => {
        const {
            service,
            getStatusListJwt,
            matchAttestationSigner,
            getStatusFromStatusListJwt,
            verifyStatusListSignature,
        } = createService({ statuses: { 3: 1 } });

        await expect(read(service, [2, 3])).resolves.toEqual(
            new Map([
                [2, 0],
                [3, 1],
            ]),
        );
        expect(matchAttestationSigner).toHaveBeenCalledWith(
            ["leaf"],
            [{ entityId: "wp" }],
        );
        expect(getStatusListJwt).toHaveBeenCalledOnce();
        expect(getStatusListJwt).toHaveBeenCalledWith(uri, "tenant");
        expect(verifyStatusListSignature).toHaveBeenCalledOnce();
        expect(verifyStatusListSignature).toHaveBeenCalledWith(
            "status-list-jwt",
            provider,
            expect.objectContaining({ entities: [{ entityId: "wp" }] }),
        );
        expect(getStatusFromStatusListJwt).toHaveBeenCalledWith(
            "status-list-jwt",
            { uri, idx: 3 },
            5,
        );
    });

    it("leaves out an index outside the list", async () => {
        const { service } = createService({
            statuses: {
                9: new StatusListIndexOutOfRange(
                    "Status list index 9 is outside the list",
                ),
            },
        });

        await expect(read(service, [1, 9])).resolves.toEqual(new Map([[1, 0]]));
    });

    it("refuses a list whose claims are wrong", async () => {
        const { service } = createService({
            statuses: {
                1: new InvalidStatusListTokenError(
                    "Status list token has expired",
                ),
            },
        });

        await expect(read(service, [1])).rejects.toThrow("has expired");
    });

    it("refuses a provider that is no longer trusted", async () => {
        const { service } = createService({ matched: false });

        await expect(read(service, [1])).rejects.toThrow(
            "no longer in the wallet provider trust lists",
        );
    });

    it("refuses a list not signed by the provider", async () => {
        const { service } = createService({ signatureValid: false });

        await expect(read(service, [1])).rejects.toThrow(
            "Status list JWT signature verification failed",
        );
    });

    it("refuses without wallet provider trust lists", async () => {
        const { service } = createService({});

        await expect(
            service.readWalletUnitStatuses("tenant", ["leaf"], uri, [1], []),
        ).rejects.toThrow("No wallet provider trust lists are configured");
    });
});
