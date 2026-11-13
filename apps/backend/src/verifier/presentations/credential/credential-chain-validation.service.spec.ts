import type { Logger } from "@nestjs/common";
import * as x509 from "@peculiar/x509";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acceptedSequenceNumbersFake } from "../../../../test/trust/accepted-trust-list-sequence-numbers.fake.js";
import {
    chainBelow,
    chainCa,
    sameSubjectCertificates,
} from "../../../../test/trust/certificate-chain.fixture.js";
import { CertificatePathBuilder } from "../../../shared/utils/certificate-path.util.js";
import { CollectTrustedEntities } from "../../../trust/application/collect-trusted-entities.js";
import { TrustStoreService } from "../../../trust/trust-store.service.js";
import type { TrustListSource } from "../../../trust/types.js";
import { X509ValidationService } from "../../../trust/x509-validation.service.js";
import {
    ChainValidationPolicy,
    CredentialChainValidationService,
} from "./credential-chain-validation.service.js";

/**
 * Regression tests for the trust-list fail-open bug.
 *
 * `getTrustStoreIfConfigured` used to swallow every load error (and stale-list
 * case) and return `null`, which `validateChain` treated identically to "no
 * trust list configured" — returning `verified: true`. A verifier that had
 * configured a LoTE trust list would then silently accept ANY credential
 * whenever the list was unreachable, unparseable, or stale. Verification must
 * instead fail closed.
 */

describe("CredentialChainValidationService — trust list availability", () => {
    const LOTE_SOURCE: TrustListSource = {
        lotes: [{ url: "https://trust.example/lote.jwt" }],
    } as TrustListSource;

    let trustStore: { getTrustStore: ReturnType<typeof vi.fn> };
    let x509v: Record<string, ReturnType<typeof vi.fn>>;
    let service: CredentialChainValidationService;
    let logger: Record<string, ReturnType<typeof vi.fn>>;

    beforeEach(() => {
        trustStore = { getTrustStore: vi.fn() };
        x509v = {
            parseX5c: vi.fn().mockReturnValue([{ subject: "leaf" }]),
        };
        logger = {
            setContext: vi.fn(),
            error: vi.fn(),
            warn: vi.fn(),
            debug: vi.fn(),
        };

        service = new CredentialChainValidationService(
            trustStore as any,
            x509v as any,
            logger as any,
        );
    });

    it("fails closed when a configured trust list cannot be loaded", async () => {
        trustStore.getTrustStore.mockRejectedValue(
            new Error("getaddrinfo ENOTFOUND trust.example"),
        );

        const result = await service.validateChain(["<cert>"], LOTE_SOURCE, {});

        expect(result.verified).toBe(false);
        expect(result.error).toBe("trust_list_unavailable");
    });

    it("fails closed when every configured trust list is past its NextUpdate", async () => {
        const loadVerified = vi.fn().mockResolvedValue({
            entities: [],
            nextUpdate: new Date(Date.now() - 86_400_000).toISOString(),
        });
        const store = new TrustStoreService(
            new CollectTrustedEntities(
                { loadVerified },
                acceptedSequenceNumbersFake(),
            ),
            {} as never,
            {} as never,
            {} as never,
            acceptedSequenceNumbersFake(),
        );
        vi.spyOn(
            (store as unknown as { logger: Logger }).logger,
            "warn",
        ).mockImplementation(() => {});
        const withRealStore = new CredentialChainValidationService(
            store,
            x509v as any,
            logger as any,
        );

        const result = await withRealStore.validateChain(
            ["<cert>"],
            {
                lotes: [
                    { url: "https://trust.example/lote.jwt" },
                    { url: "https://trust.example/second.jwt" },
                ],
            } as TrustListSource,
            {},
        );

        expect(result.verified).toBe(false);
        expect(result.error).toBe("trust_list_unavailable");
        expect(loadVerified).toHaveBeenCalledTimes(2);
    });

    it("skips trust validation (opt-out) when no trust list is configured", async () => {
        // No lotes configured → legitimate opt-out, preserve fail-open behavior.
        const result = await service.validateChain(["<cert>"], undefined, {});

        expect(result.verified).toBe(true);
        expect(trustStore.getTrustStore).not.toHaveBeenCalled();
    });

    it("does not throw from best-effort buffer loading when the trust list is unavailable", async () => {
        trustStore.getTrustStore.mockRejectedValue(new Error("boom"));

        // Non-authoritative anchor augmentation: returns [] rather than throwing.
        await expect(
            service.getTrustedCertificateEntries(LOTE_SOURCE),
        ).resolves.toEqual([]);
    });
});

/**
 * The status list of a presented credential must be signed under the
 * revocation service of the entity that issued the credential, or, if that
 * entity lists no revocation service, under the certificate its credential
 * chain matched. Any other signer could serve a list in which a revoked
 * credential is valid.
 */
describe("CredentialChainValidationService — status list signer", () => {
    const algorithm = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
    const LOTE_SOURCE = {
        lotes: [{ url: "https://trust.example/lote.jwt" }],
    } as TrustListSource;
    const ISSUANCE = "http://uri.etsi.org/19602/SvcType/EAA/Issuance";
    const REVOCATION = "http://uri.etsi.org/19602/SvcType/EAA/Revocation";
    const PID_ISSUANCE = "http://uri.etsi.org/19602/SvcType/PID/Issuance";
    const PID_REVOCATION = "http://uri.etsi.org/19602/SvcType/PID/Revocation";
    const WALLET_ISSUANCE =
        "http://uri.etsi.org/19602/SvcType/WalletSolution/Issuance";
    const WALLET_REVOCATION =
        "http://uri.etsi.org/19602/SvcType/WalletSolution/Revocation";
    let serial = 1;

    type Cert = { cert: x509.X509Certificate; keys: CryptoKeyPair };

    const generateKeys = () =>
        crypto.subtle.generateKey(algorithm, true, [
            "sign",
            "verify",
        ]) as Promise<CryptoKeyPair>;

    async function selfSigned(name: string, ca: boolean): Promise<Cert> {
        const keys = await generateKeys();
        const cert = await x509.X509CertificateGenerator.createSelfSigned({
            serialNumber: String(serial++).padStart(2, "0"),
            name: `CN=${name}`,
            notBefore: new Date(Date.now() - 60_000),
            notAfter: new Date(Date.now() + 3_600_000),
            keys,
            signingAlgorithm: algorithm,
            extensions: ca
                ? [new x509.BasicConstraintsExtension(true, undefined, true)]
                : [],
        });
        return { cert, keys };
    }

    async function issuedBy(issuer: Cert, name: string): Promise<Cert> {
        const keys = await generateKeys();
        const cert = await x509.X509CertificateGenerator.create({
            serialNumber: String(serial++).padStart(2, "0"),
            subject: `CN=${name}`,
            issuer: issuer.cert.subject,
            notBefore: new Date(Date.now() - 60_000),
            notAfter: new Date(Date.now() + 3_600_000),
            publicKey: keys.publicKey,
            signingKey: issuer.keys.privateKey,
            signingAlgorithm: algorithm,
        });
        return { cert, keys };
    }

    const b64 = ({ cert }: Cert) =>
        Buffer.from(cert.rawData).toString("base64");

    function serviceWith(
        entities: {
            entityId: string;
            services: { serviceTypeIdentifier: string; cert: Cert }[];
        }[],
    ) {
        const store = {
            entities: entities.map((e) => ({
                entityId: e.entityId,
                services: e.services.map((s) => ({
                    serviceTypeIdentifier: s.serviceTypeIdentifier,
                    certValue: b64(s.cert),
                })),
            })),
            discarded: [],
        };
        return new CredentialChainValidationService(
            { getTrustStore: vi.fn().mockResolvedValue(store) } as any,
            new X509ValidationService(),
            {
                setContext: vi.fn(),
                error: vi.fn(),
                warn: vi.fn(),
                debug: vi.fn(),
            } as any,
        );
    }

    /** The entity the credential chain matched, as the SD-JWT VC verifier gets it. */
    async function credentialMatch(
        service: CredentialChainValidationService,
        x5c: string[],
        policy: ChainValidationPolicy = {},
    ) {
        const result = await service.validateChain(x5c, LOTE_SOURCE, policy);
        expect(result.verified).toBe(true);
        return result.matchedEntity;
    }

    // ETSI TS 119 602 §6.3.15: an outdated list is discarded on its own; the
    // issuers of the current lists are still trusted.
    describe("with an outdated trust list next to a current one", () => {
        const day = 86_400_000;
        const OUTDATED_URL = "https://trust.example/outdated.jwt";

        async function serviceWithLists() {
            const currentCa = await selfSigned("Current Issuer CA", true);
            const outdatedCa = await selfSigned("Outdated Issuer CA", true);
            const entity = (entityId: string, ca: Cert) => ({
                entityId,
                services: [
                    { serviceTypeIdentifier: ISSUANCE, certValue: b64(ca) },
                ],
            });
            const loadVerified = vi
                .fn()
                .mockResolvedValueOnce({
                    entities: [entity("current", currentCa)],
                    nextUpdate: new Date(Date.now() + day).toISOString(),
                    sequenceNumber: 1,
                })
                .mockResolvedValueOnce({
                    entities: [entity("outdated", outdatedCa)],
                    nextUpdate: new Date(Date.now() - day).toISOString(),
                    sequenceNumber: 1,
                });
            const store = new TrustStoreService(
                new CollectTrustedEntities(
                    { loadVerified },
                    acceptedSequenceNumbersFake(),
                ),
                {} as never,
                {} as never,
                {} as never,
                acceptedSequenceNumbersFake(),
            );
            vi.spyOn(
                (store as unknown as { logger: Logger }).logger,
                "warn",
            ).mockImplementation(() => {});
            const service = new CredentialChainValidationService(
                store,
                new X509ValidationService(),
                {
                    setContext: vi.fn(),
                    error: vi.fn(),
                    warn: vi.fn(),
                    debug: vi.fn(),
                } as any,
            );
            const source = {
                tenantId: "t",
                lotes: [
                    { url: "https://trust.example/current.jwt" },
                    { url: OUTDATED_URL },
                ],
            } as TrustListSource;
            return { service, source, currentCa, outdatedCa };
        }

        it("accepts a credential of an issuer in the current list", async () => {
            const { service, source, currentCa } = await serviceWithLists();
            const signer = await issuedBy(currentCa, "Credential");

            await expect(
                service.validateChain([b64(signer)], source, {}),
            ).resolves.toMatchObject({ verified: true });
        });

        it("rejects a credential of an issuer only in the outdated list, naming the list in the details", async () => {
            const { service, source, outdatedCa } = await serviceWithLists();
            const signer = await issuedBy(outdatedCa, "Credential");

            const result = await service.validateChain(
                [b64(signer)],
                source,
                {},
            );

            expect(result.verified).toBe(false);
            expect(result.error).not.toBe("trust_list_unavailable");
            expect(result.errorDetails).toContain(
                `Discarded outdated trust lists (their issuers are not trusted): ${OUTDATED_URL}`,
            );
        });

        it("names the discarded lists for verifiers that check anchors themselves", async () => {
            const { service, source } = await serviceWithLists();

            await expect(
                service.discardedTrustListsDetail(source),
            ).resolves.toContain(OUTDATED_URL);
        });
    });

    describe("entity without a revocation service", () => {
        let issuerCa: Cert;
        let otherCa: Cert;
        let service: CredentialChainValidationService;

        beforeEach(async () => {
            issuerCa = await selfSigned("Issuer CA", true);
            otherCa = await selfSigned("Other Issuer CA", true);
            service = serviceWith([
                {
                    entityId: "issuer",
                    services: [
                        { serviceTypeIdentifier: ISSUANCE, cert: issuerCa },
                    ],
                },
                {
                    entityId: "other",
                    services: [
                        { serviceTypeIdentifier: ISSUANCE, cert: otherCa },
                    ],
                },
            ]);
        });

        it("accepts a status list signed under the matched issuance CA", async () => {
            const credentialSigner = await issuedBy(issuerCa, "Credential");
            const statusSigner = await issuedBy(issuerCa, "Status List");
            const matched = await credentialMatch(service, [
                b64(credentialSigner),
            ]);

            await expect(
                service.verifyStatusListSignature(
                    [b64(statusSigner)],
                    matched,
                    LOTE_SOURCE,
                ),
            ).resolves.toBe(true);
        });

        it("rejects a status list signed by an untrusted key", async () => {
            const credentialSigner = await issuedBy(issuerCa, "Credential");
            const matched = await credentialMatch(service, [
                b64(credentialSigner),
            ]);
            const attacker = await selfSigned("Attacker", false);

            await expect(
                service.verifyStatusListSignature(
                    [b64(attacker)],
                    matched,
                    LOTE_SOURCE,
                ),
            ).resolves.toBe(false);
        });

        it("rejects a status list signed under another trusted issuer", async () => {
            const credentialSigner = await issuedBy(issuerCa, "Credential");
            const matched = await credentialMatch(service, [
                b64(credentialSigner),
            ]);
            const otherSigner = await issuedBy(otherCa, "Other Status List");

            await expect(
                service.verifyStatusListSignature(
                    [b64(otherSigner)],
                    matched,
                    LOTE_SOURCE,
                ),
            ).resolves.toBe(false);
        });

        it("rejects a status list without x5c", async () => {
            const credentialSigner = await issuedBy(issuerCa, "Credential");
            const matched = await credentialMatch(service, [
                b64(credentialSigner),
            ]);

            await expect(
                service.verifyStatusListSignature(
                    undefined,
                    matched,
                    LOTE_SOURCE,
                ),
            ).resolves.toBe(false);
        });
    });

    describe("entity with a pinned issuance certificate", () => {
        it("accepts a status list signed with the pinned certificate only", async () => {
            const pinned = await selfSigned("Pinned Issuer", false);
            const service = serviceWith([
                {
                    entityId: "issuer",
                    services: [
                        { serviceTypeIdentifier: ISSUANCE, cert: pinned },
                    ],
                },
            ]);
            const matched = await credentialMatch(service, [b64(pinned)]);
            const other = await selfSigned("Other", false);

            await expect(
                service.verifyStatusListSignature(
                    [b64(pinned)],
                    matched,
                    LOTE_SOURCE,
                ),
            ).resolves.toBe(true);
            await expect(
                service.verifyStatusListSignature(
                    [b64(other)],
                    matched,
                    LOTE_SOURCE,
                ),
            ).resolves.toBe(false);
        });
    });

    describe("entity with a revocation service other than EAA/Revocation", () => {
        it("requires the status list to chain to that revocation service", async () => {
            const issuerCa = await selfSigned("PID Provider CA", true);
            const revocationCa = await selfSigned("PID Revocation CA", true);
            const service = serviceWith([
                {
                    entityId: "pid-provider",
                    services: [
                        { serviceTypeIdentifier: PID_ISSUANCE, cert: issuerCa },
                        {
                            serviceTypeIdentifier: PID_REVOCATION,
                            cert: revocationCa,
                        },
                    ],
                },
            ]);
            const matched = await credentialMatch(service, [
                b64(await issuedBy(issuerCa, "PID")),
            ]);

            await expect(
                service.verifyStatusListSignature(
                    [b64(await issuedBy(revocationCa, "Status List"))],
                    matched,
                    LOTE_SOURCE,
                ),
            ).resolves.toBe(true);
            await expect(
                service.verifyStatusListSignature(
                    [b64(await selfSigned("Attacker", false))],
                    matched,
                    LOTE_SOURCE,
                ),
            ).resolves.toBe(false);
        });
    });

    // ARF Annex 2 VCR_01: a credential under a certificate listed with a PID
    // issuance service is a PID, whichever service the chain matched first.
    describe("PID issuer", () => {
        it.each<[string, string[][], boolean]>([
            ["a PID issuer", [[PID_ISSUANCE]], true],
            ["an EAA issuer", [[ISSUANCE]], false],
            [
                "an EAA and, later, a PID issuer",
                [[ISSUANCE, PID_ISSUANCE]],
                true,
            ],
            [
                "an EAA issuer in one entity and a PID issuer in a later one",
                [[ISSUANCE], [PID_ISSUANCE]],
                true,
            ],
        ])("reports a CA listed as %s", async (_, entities, pidIssuer) => {
            const ca = await selfSigned("Issuer CA", true);
            const service = serviceWith(
                entities.map((types, i) => ({
                    entityId: `issuer-${i}`,
                    services: types.map((serviceTypeIdentifier) => ({
                        serviceTypeIdentifier,
                        cert: ca,
                    })),
                })),
            );

            const result = await service.validateChain(
                [b64(await issuedBy(ca, "Credential"))],
                LOTE_SOURCE,
            );

            expect(result).toMatchObject({
                verified: true,
                pidIssuer,
                // The first match still decides the status list signers.
                matchedEntity: { issuanceServiceType: entities[0][0] },
            });
        });
    });

    describe("CA listed as EAA issuer and, as another certificate with the same key, as PID issuer", () => {
        let eaaCopy: Cert;
        let pidCopy: Cert;
        let service: CredentialChainValidationService;

        beforeEach(async () => {
            // Two self-signed roots with the same subject and key: a path
            // can end at either.
            const keys = await generateKeys();
            const root = (
                serialNumber: string,
                notAfter = Date.now() + 3_600_000,
            ) =>
                x509.X509CertificateGenerator.createSelfSigned({
                    serialNumber,
                    name: "CN=Provider CA",
                    notBefore: new Date(Date.now() - 7_200_000),
                    notAfter: new Date(notAfter),
                    keys,
                    signingAlgorithm: algorithm,
                    extensions: [
                        new x509.BasicConstraintsExtension(
                            true,
                            undefined,
                            true,
                        ),
                    ],
                });
            eaaCopy = { cert: await root("a1"), keys };
            // Expired: the listing still makes the issuer a PID provider.
            pidCopy = { cert: await root("a2", Date.now() - 3_600_000), keys };
            service = serviceWith([
                {
                    entityId: "eaa-list-entry",
                    services: [
                        { serviceTypeIdentifier: ISSUANCE, cert: eaaCopy },
                    ],
                },
                {
                    entityId: "pid-list-entry",
                    services: [
                        { serviceTypeIdentifier: PID_ISSUANCE, cert: pidCopy },
                    ],
                },
            ]);
        });

        it.each([
            ["only the leaf", false],
            ["the EAA copy after the leaf", true],
        ])(
            "reports a PID issuer when the chain carries %s",
            async (_, withCopy) => {
                const leaf = await issuedBy(eaaCopy, "PID");

                const result = await service.validateChain(
                    [b64(leaf), ...(withCopy ? [b64(eaaCopy)] : [])],
                    LOTE_SOURCE,
                );

                expect(result).toMatchObject({
                    verified: true,
                    pidIssuer: true,
                    matchedEntity: { issuanceServiceType: ISSUANCE },
                });
            },
        );
    });

    it("reports a pinned end-entity certificate listed as EAA and as PID issuer", async () => {
        const pinned = await selfSigned("Document Signer", false);
        const service = serviceWith([
            {
                entityId: "issuer",
                services: [
                    { serviceTypeIdentifier: ISSUANCE, cert: pinned },
                    { serviceTypeIdentifier: PID_ISSUANCE, cert: pinned },
                ],
            },
        ]);

        const result = await service.validateChain([b64(pinned)], LOTE_SOURCE);

        expect(result).toMatchObject({
            verified: true,
            pidIssuer: true,
            matchedEntity: { issuanceServiceType: ISSUANCE },
        });
    });

    it("is not thrown off by a PID certificate that does not parse", async () => {
        const eaaCa = await selfSigned("EAA Issuer CA", true);
        const unparseable = {
            cert: { rawData: new Uint8Array(3) },
        } as unknown as Cert;
        const service = serviceWith([
            {
                entityId: "eaa-provider",
                services: [{ serviceTypeIdentifier: ISSUANCE, cert: eaaCa }],
            },
            {
                entityId: "pid-provider",
                services: [
                    { serviceTypeIdentifier: PID_ISSUANCE, cert: unparseable },
                ],
            },
        ]);

        const result = await service.validateChain(
            [b64(await issuedBy(eaaCa, "Credential"))],
            LOTE_SOURCE,
        );

        expect(result).toMatchObject({ verified: true, pidIssuer: false });
    });

    it("does not report a CA listed as EAA issuer when another CA of the entity is a PID issuer", async () => {
        const eaaCa = await selfSigned("EAA Issuer CA", true);
        const pidCa = await selfSigned("PID Issuer CA", true);
        const service = serviceWith([
            {
                entityId: "multi-role-provider",
                services: [
                    { serviceTypeIdentifier: ISSUANCE, cert: eaaCa },
                    { serviceTypeIdentifier: PID_ISSUANCE, cert: pidCa },
                ],
            },
        ]);

        const result = await service.validateChain(
            [b64(await issuedBy(eaaCa, "Credential"))],
            LOTE_SOURCE,
        );

        expect(result).toMatchObject({
            verified: true,
            pidIssuer: false,
            matchedEntity: { issuanceServiceType: ISSUANCE },
        });
    });

    describe("entity that also lists a wallet solution", () => {
        let pidCa: Cert;
        let pidRevocationCa: Cert;
        let walletCa: Cert;
        let walletRevocationCa: Cert;
        let service: CredentialChainValidationService;

        beforeEach(async () => {
            pidCa = await selfSigned("PID Provider CA", true);
            pidRevocationCa = await selfSigned("PID Revocation CA", true);
            walletCa = await selfSigned("Wallet Provider CA", true);
            walletRevocationCa = await selfSigned("Wallet Revocation CA", true);
            service = serviceWith([
                {
                    entityId: "pid-and-wallet-provider",
                    services: [
                        {
                            serviceTypeIdentifier: WALLET_ISSUANCE,
                            cert: walletCa,
                        },
                        {
                            serviceTypeIdentifier: WALLET_REVOCATION,
                            cert: walletRevocationCa,
                        },
                        { serviceTypeIdentifier: PID_ISSUANCE, cert: pidCa },
                        {
                            serviceTypeIdentifier: PID_REVOCATION,
                            cert: pidRevocationCa,
                        },
                    ],
                },
            ]);
        });

        it("rejects a credential under its WalletSolution/Issuance certificate", async () => {
            const result = await service.validateChain(
                [b64(await issuedBy(walletCa, "Credential"))],
                LOTE_SOURCE,
            );

            expect(result.verified).toBe(false);
            expect(result.error).toBe("no_trusted_entity_match");
        });

        it("accepts a PID/Revocation signer for a PID credential, not a WalletSolution/Revocation signer", async () => {
            const matched = await credentialMatch(service, [
                b64(await issuedBy(pidCa, "PID")),
            ]);
            expect(matched?.issuanceServiceType).toBe(PID_ISSUANCE);

            await expect(
                service.verifyStatusListSignature(
                    [b64(await issuedBy(pidRevocationCa, "Status List"))],
                    matched,
                    LOTE_SOURCE,
                ),
            ).resolves.toBe(true);
            await expect(
                service.verifyStatusListSignature(
                    [b64(await issuedBy(walletRevocationCa, "Status List"))],
                    matched,
                    LOTE_SOURCE,
                ),
            ).resolves.toBe(false);
        });

        it("requires the issuance certificate when only another profile's revocation service is listed", async () => {
            const onlyWalletRevocation = serviceWith([
                {
                    entityId: "pid-provider",
                    services: [
                        { serviceTypeIdentifier: PID_ISSUANCE, cert: pidCa },
                        {
                            serviceTypeIdentifier: WALLET_REVOCATION,
                            cert: walletRevocationCa,
                        },
                    ],
                },
            ]);
            const matched = await credentialMatch(onlyWalletRevocation, [
                b64(await issuedBy(pidCa, "PID")),
            ]);

            await expect(
                onlyWalletRevocation.verifyStatusListSignature(
                    [b64(await issuedBy(walletRevocationCa, "Status List"))],
                    matched,
                    LOTE_SOURCE,
                ),
            ).resolves.toBe(false);
            await expect(
                onlyWalletRevocation.verifyStatusListSignature(
                    [b64(await issuedBy(pidCa, "Status List"))],
                    matched,
                    LOTE_SOURCE,
                ),
            ).resolves.toBe(true);
        });

        it("gives the mdoc library one entry per credential issuer service with its paired status signers", async () => {
            const eaaCa = await selfSigned("EAA Provider CA", true);
            const withEaa = serviceWith([
                {
                    entityId: "pid-and-wallet-provider",
                    services: [
                        {
                            serviceTypeIdentifier: WALLET_ISSUANCE,
                            cert: walletCa,
                        },
                        {
                            serviceTypeIdentifier: WALLET_REVOCATION,
                            cert: walletRevocationCa,
                        },
                        { serviceTypeIdentifier: PID_ISSUANCE, cert: pidCa },
                        {
                            serviceTypeIdentifier: PID_REVOCATION,
                            cert: pidRevocationCa,
                        },
                    ],
                },
                {
                    entityId: "eaa-provider",
                    services: [
                        { serviceTypeIdentifier: ISSUANCE, cert: eaaCa },
                    ],
                },
            ]);
            const der = ({ cert }: Cert) => new Uint8Array(cert.rawData);

            await expect(
                withEaa.getTrustedCertificateEntries(LOTE_SOURCE),
            ).resolves.toEqual([
                { issuance: [der(pidCa)], status: [der(pidRevocationCa)] },
                { issuance: [der(eaaCa)], status: [der(eaaCa)] },
            ]);
        });

        it("shares one status array between the mdoc entries of a service type", async () => {
            const secondPidCa = await selfSigned("Second PID CA", true);
            const entries = await serviceWith([
                {
                    entityId: "pid-provider",
                    services: [
                        { serviceTypeIdentifier: PID_ISSUANCE, cert: pidCa },
                        {
                            serviceTypeIdentifier: PID_ISSUANCE,
                            cert: secondPidCa,
                        },
                        {
                            serviceTypeIdentifier: PID_REVOCATION,
                            cert: pidRevocationCa,
                        },
                    ],
                },
            ]).getTrustedCertificateEntries(LOTE_SOURCE);

            expect(entries).toHaveLength(2);
            expect(entries[0].status).toEqual([
                new Uint8Array(pidRevocationCa.cert.rawData),
            ]);
            expect(entries[1].status).toBe(entries[0].status);
        });

        it("drops mdoc entries and status signers whose certificate does not parse", async () => {
            const warn = vi.fn();
            const withBrokenCerts = new CredentialChainValidationService(
                {
                    getTrustStore: vi.fn().mockResolvedValue({
                        entities: [
                            {
                                entityId: "broken-revocation",
                                services: [
                                    {
                                        serviceTypeIdentifier: PID_ISSUANCE,
                                        certValue: b64(pidCa),
                                    },
                                    {
                                        serviceTypeIdentifier: PID_REVOCATION,
                                        certValue: "not a certificate",
                                    },
                                ],
                            },
                            {
                                entityId: "broken-issuance",
                                services: [
                                    {
                                        serviceTypeIdentifier: ISSUANCE,
                                        certValue: "not a certificate",
                                    },
                                ],
                            },
                        ],
                    }),
                } as any,
                new X509ValidationService(),
                {
                    setContext: vi.fn(),
                    error: vi.fn(),
                    warn,
                    debug: vi.fn(),
                } as any,
            );

            // No status signer is left for the PID entry: the mdoc library
            // then rejects its status lists instead of trusting another
            // certificate.
            await expect(
                withBrokenCerts.getTrustedCertificateEntries(LOTE_SOURCE),
            ).resolves.toEqual([
                { issuance: [new Uint8Array(pidCa.cert.rawData)], status: [] },
            ]);
            expect(warn).toHaveBeenCalledTimes(2);
        });
    });

    describe("entity with a pinned issuance certificate in pathEnd mode", () => {
        it("accepts a status list whose path ends at the pinned certificate only", async () => {
            const pinned = await selfSigned("Pinned Issuer", false);
            const service = serviceWith([
                {
                    entityId: "issuer",
                    services: [
                        { serviceTypeIdentifier: ISSUANCE, cert: pinned },
                    ],
                },
            ]);
            const policy = { pinnedCertMode: "pathEnd" as const };
            const matched = await credentialMatch(
                service,
                [b64(await issuedBy(pinned, "Credential"))],
                policy,
            );
            expect(matched?.matchMode).toBe("pathEnd-pinned");

            await expect(
                service.verifyStatusListSignature(
                    [b64(await issuedBy(pinned, "Status List"))],
                    matched,
                    LOTE_SOURCE,
                    policy,
                ),
            ).resolves.toBe(true);
            await expect(
                service.verifyStatusListSignature(
                    [b64(await selfSigned("Attacker", false))],
                    matched,
                    LOTE_SOURCE,
                    policy,
                ),
            ).resolves.toBe(false);
        });
    });

    describe("entity with an EAA/Revocation service", () => {
        let issuerCa: Cert;
        let revocationCa: Cert;
        let otherRevocationCa: Cert;
        const entities = () => [
            {
                // Both entities share one name: entities are told apart by
                // certificate, not by entityId.
                entityId: "Club",
                services: [
                    { serviceTypeIdentifier: ISSUANCE, cert: issuerCa },
                    { serviceTypeIdentifier: REVOCATION, cert: revocationCa },
                ],
            },
            {
                entityId: "Club",
                services: [
                    {
                        serviceTypeIdentifier: REVOCATION,
                        cert: otherRevocationCa,
                    },
                ],
            },
        ];

        beforeEach(async () => {
            issuerCa = await selfSigned("Issuer CA", true);
            revocationCa = await selfSigned("Revocation CA", true);
            otherRevocationCa = await selfSigned("Other Revocation CA", true);
        });

        it("accepts only a status list signed under its own revocation certificate", async () => {
            const service = serviceWith(entities());
            const matched = await credentialMatch(service, [
                b64(await issuedBy(issuerCa, "Credential")),
            ]);

            await expect(
                service.verifyStatusListSignature(
                    [b64(await issuedBy(revocationCa, "Status List"))],
                    matched,
                    LOTE_SOURCE,
                ),
            ).resolves.toBe(true);
            await expect(
                service.verifyStatusListSignature(
                    [b64(await issuedBy(issuerCa, "Status List"))],
                    matched,
                    LOTE_SOURCE,
                ),
            ).resolves.toBe(false);
            await expect(
                service.verifyStatusListSignature(
                    [b64(await issuedBy(otherRevocationCa, "Status List"))],
                    matched,
                    LOTE_SOURCE,
                ),
            ).resolves.toBe(false);
        });

        it("accepts a pinned revocation certificate as leaf, or as path end in pathEnd mode", async () => {
            const pinnedRevocation = await selfSigned(
                "Pinned Revocation",
                false,
            );
            const service = serviceWith([
                {
                    entityId: "Club",
                    services: [
                        { serviceTypeIdentifier: ISSUANCE, cert: issuerCa },
                        {
                            serviceTypeIdentifier: REVOCATION,
                            cert: pinnedRevocation,
                        },
                    ],
                },
            ]);
            const matched = await credentialMatch(service, [
                b64(await issuedBy(issuerCa, "Credential")),
            ]);
            const below = [
                b64(await issuedBy(pinnedRevocation, "Status List")),
            ];

            await expect(
                service.verifyStatusListSignature(
                    [b64(pinnedRevocation)],
                    matched,
                    LOTE_SOURCE,
                ),
            ).resolves.toBe(true);
            await expect(
                service.verifyStatusListSignature(below, matched, LOTE_SOURCE),
            ).resolves.toBe(false);
            await expect(
                service.verifyStatusListSignature(below, matched, LOTE_SOURCE, {
                    pinnedCertMode: "pathEnd",
                }),
            ).resolves.toBe(true);
        });
    });

    /**
     * Two key chains imported with the same private key each get their own
     * self-signed root with the same subject. A leaf signed with that key
     * verifies under both roots, so the path must end at the root of the
     * service type being checked (the demo tenant's attestation and status
     * list key chains shared a key).
     */
    describe("issuance and revocation CAs with the same subject and key", () => {
        async function selfSignedWith(
            keys: CryptoKeyPair,
            name: string,
        ): Promise<Cert> {
            const cert = await x509.X509CertificateGenerator.createSelfSigned({
                serialNumber: String(serial++).padStart(2, "0"),
                name: `CN=${name}`,
                notBefore: new Date(Date.now() - 60_000),
                notAfter: new Date(Date.now() + 3_600_000),
                keys,
                signingAlgorithm: algorithm,
                extensions: [
                    new x509.BasicConstraintsExtension(true, undefined, true),
                ],
            });
            return { cert, keys };
        }

        let issuanceRoot: Cert;
        let revocationRoot: Cert;

        beforeEach(async () => {
            const sharedKey = await generateKeys();
            issuanceRoot = await selfSignedWith(
                sharedKey,
                "Demo Tenant Root CA",
            );
            revocationRoot = await selfSignedWith(
                sharedKey,
                "Demo Tenant Root CA",
            );
        });

        for (const order of ["issuance first", "revocation first"] as const) {
            it(`accepts the status list and the credential (${order})`, async () => {
                const services = [
                    { serviceTypeIdentifier: PID_ISSUANCE, cert: issuanceRoot },
                    {
                        serviceTypeIdentifier: PID_REVOCATION,
                        cert: revocationRoot,
                    },
                ];
                const service = serviceWith([
                    {
                        entityId: "PID Provider",
                        services:
                            order === "issuance first"
                                ? services
                                : [...services].reverse(),
                    },
                ]);

                const credentialResult = await service.validateChain(
                    [b64(await issuedBy(issuanceRoot, "Demo Tenant"))],
                    LOTE_SOURCE,
                );
                expect(credentialResult.verified).toBe(true);
                expect(credentialResult.path?.at(-1)?.serialNumber).toBe(
                    issuanceRoot.cert.serialNumber,
                );

                await expect(
                    service.verifyStatusListSignature(
                        [b64(await issuedBy(revocationRoot, "Demo Tenant"))],
                        credentialResult.matchedEntity,
                        LOTE_SOURCE,
                    ),
                ).resolves.toBe(true);
            });
        }

        function withOtherEntity(otherRoot: Cert) {
            // The other entity is listed first, so its root is the first
            // candidate with the right subject.
            return serviceWith([
                {
                    entityId: "Other",
                    services: [
                        {
                            serviceTypeIdentifier: PID_REVOCATION,
                            cert: otherRoot,
                        },
                    ],
                },
                {
                    entityId: "PID Provider",
                    services: [
                        {
                            serviceTypeIdentifier: PID_ISSUANCE,
                            cert: issuanceRoot,
                        },
                        {
                            serviceTypeIdentifier: PID_REVOCATION,
                            cert: revocationRoot,
                        },
                    ],
                },
            ]);
        }

        it("prefers the matched entity's revocation root over another entity's root with the same subject and key", async () => {
            const otherRoot = await selfSignedWith(
                issuanceRoot.keys,
                "Demo Tenant Root CA",
            );
            const service = withOtherEntity(otherRoot);
            const matched = await credentialMatch(service, [
                b64(await issuedBy(issuanceRoot, "Demo Tenant")),
            ]);

            await expect(
                service.verifyStatusListSignature(
                    [b64(await issuedBy(revocationRoot, "Demo Tenant"))],
                    matched,
                    LOTE_SOURCE,
                ),
            ).resolves.toBe(true);
        });

        it("rejects a status list signed under another entity's root with the same subject", async () => {
            const otherRoot = await selfSigned("Demo Tenant Root CA", true);
            const service = withOtherEntity(otherRoot);
            const matched = await credentialMatch(service, [
                b64(await issuedBy(issuanceRoot, "Demo Tenant")),
            ]);

            await expect(
                service.verifyStatusListSignature(
                    [b64(await issuedBy(otherRoot, "Demo Tenant"))],
                    matched,
                    LOTE_SOURCE,
                ),
            ).resolves.toBe(false);
        });
    });

    // Every listed certificate is in the path builder's pool, and each one
    // with the issuer's subject costs a signature check; whoever publishes a
    // list decides how many there are.
    describe("with 100 listed certificates sharing an issuer's subject", () => {
        const tooManyChecks =
            "Certificate path not found within 64 signature checks";

        afterEach(() => {
            vi.restoreAllMocks();
        });

        /** `ca` listed as `serviceType` after 100 certificates with its subject. */
        async function crowded(ca: Cert, serviceType: string) {
            const decoys = await sameSubjectCertificates(ca.cert.subject, 100);
            return [
                ...decoys.map((cert) => ({
                    serviceTypeIdentifier: serviceType,
                    cert: { cert, keys: ca.keys },
                })),
                { serviceTypeIdentifier: serviceType, cert: ca },
            ];
        }

        it("rejects a credential with chain_build_failed after 64 signature checks", async () => {
            const issuerCa = await chainCa("CN=Crowded Issuer CA");
            const service = serviceWith([
                {
                    entityId: "issuer",
                    services: await crowded(issuerCa, ISSUANCE),
                },
            ]);
            const { x5c } = await chainBelow(issuerCa, 1);
            const verify = vi.spyOn(x509.X509Certificate.prototype, "verify");

            await expect(
                service.validateChain(x5c, LOTE_SOURCE),
            ).resolves.toMatchObject({
                verified: false,
                matchedEntity: null,
                error: "chain_build_failed",
                errorDetails: expect.stringContaining(
                    `Error: ${tooManyChecks}`,
                ),
            });
            expect(verify).toHaveBeenCalledTimes(64);
        });

        // Classifying the issuer builds the path again with the PID-listed
        // certificates first; a credential that cannot be classified must
        // not be spared the rules for PIDs.
        it("rejects a credential whose PID classification takes more than 64 signature checks", async () => {
            const issuerCa = await chainCa("CN=Crowded Issuer CA");
            const service = serviceWith([
                {
                    entityId: "pid lookalikes",
                    services: (await crowded(issuerCa, PID_ISSUANCE)).slice(
                        0,
                        -1,
                    ),
                },
                {
                    entityId: "issuer",
                    services: [
                        { serviceTypeIdentifier: ISSUANCE, cert: issuerCa },
                    ],
                },
            ]);
            // The CA in x5c ends the path for the match within two checks.
            const { x5c } = await chainBelow(issuerCa, 1);

            await expect(
                service.validateChain(
                    [
                        ...x5c,
                        Buffer.from(issuerCa.cert.rawData).toString("base64"),
                    ],
                    LOTE_SOURCE,
                ),
            ).resolves.toMatchObject({
                verified: false,
                error: "chain_build_failed",
                errorDetails: expect.stringContaining(
                    `Error: ${tooManyChecks}`,
                ),
            });
        });

        it("rejects a status list after 64 signature checks", async () => {
            const issuerCa = await chainCa("CN=Issuer CA");
            const revocationCa = await chainCa("CN=Crowded Revocation CA");
            const service = serviceWith([
                {
                    entityId: "issuer",
                    services: [
                        { serviceTypeIdentifier: ISSUANCE, cert: issuerCa },
                        ...(await crowded(revocationCa, REVOCATION)),
                    ],
                },
            ]);
            const matched = await credentialMatch(
                service,
                (await chainBelow(issuerCa, 1)).x5c,
            );
            const { x5c } = await chainBelow(revocationCa, 1);
            const verify = vi.spyOn(x509.X509Certificate.prototype, "verify");

            await expect(
                service.verifyStatusListSignature(x5c, matched, LOTE_SOURCE),
            ).resolves.toBe(false);
            expect(verify).toHaveBeenCalledTimes(64);
        });
    });

    // The chain builder's work grows with the square of the chain's length.
    // The wallet decides how long a credential's x5c is, the issuer's status
    // list host how long a status list's is.
    describe("x5c of more than ten certificates", () => {
        const tooLong = "x5c holds 11 certificates; at most 10 are accepted";
        let issuerCa: Cert;
        let service: CredentialChainValidationService;

        beforeEach(async () => {
            issuerCa = await chainCa("CN=Length Issuer CA");
            service = serviceWith([
                {
                    entityId: "issuer",
                    services: [
                        { serviceTypeIdentifier: ISSUANCE, cert: issuerCa },
                    ],
                },
            ]);
        });

        afterEach(() => {
            vi.restoreAllMocks();
        });

        it("accepts a credential whose x5c holds ten certificates", async () => {
            const { x5c } = await chainBelow(issuerCa, 10);

            await expect(credentialMatch(service, x5c)).resolves.not.toBeNull();
        });

        it("rejects a credential whose x5c holds eleven certificates as invalid_x5c, without building", async () => {
            const { x5c } = await chainBelow(issuerCa, 11);
            const build = vi.spyOn(CertificatePathBuilder.prototype, "build");

            await expect(
                service.validateChain(x5c, LOTE_SOURCE),
            ).resolves.toEqual({
                verified: false,
                matchedEntity: null,
                error: "invalid_x5c",
                errorDetails: tooLong,
            });
            expect(build).not.toHaveBeenCalled();
        });

        it("rejects a credential whose x5c holds eleven certificates also without a trust list", async () => {
            const { x5c } = await chainBelow(issuerCa, 11);

            await expect(
                service.validateChain(x5c, undefined),
            ).resolves.toEqual({
                verified: false,
                matchedEntity: null,
                error: "invalid_x5c",
                errorDetails: tooLong,
            });
        });

        it("still names a certificate that cannot be parsed", async () => {
            await expect(
                service.validateChain(["not a certificate"], LOTE_SOURCE),
            ).resolves.toMatchObject({
                verified: false,
                error: "invalid_x5c",
                errorDetails: expect.stringMatching(
                    /^Failed to parse x5c chain: /,
                ),
            });
        });

        it("rejects a status list whose x5c holds eleven certificates, without building", async () => {
            const matched = await credentialMatch(
                service,
                (await chainBelow(issuerCa, 1)).x5c,
            );
            const { x5c } = await chainBelow(issuerCa, 11);
            const build = vi.spyOn(CertificatePathBuilder.prototype, "build");

            await expect(
                service.verifyStatusListSignature(x5c, matched, LOTE_SOURCE),
            ).resolves.toBe(false);
            expect(build).not.toHaveBeenCalled();
        });
    });
});
