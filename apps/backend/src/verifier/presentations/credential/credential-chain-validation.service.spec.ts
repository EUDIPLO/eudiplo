import * as x509 from "@peculiar/x509";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

    beforeEach(() => {
        trustStore = { getTrustStore: vi.fn() };
        x509v = {
            parseX5c: vi.fn().mockReturnValue([{ subject: "leaf" }]),
        };
        const logger = {
            setContext: vi.fn(),
            error: vi.fn(),
            warn: vi.fn(),
            debug: vi.fn(),
        };

        service = new CredentialChainValidationService(
            trustStore as any,
            x509v as any,
            {} as any, // statusListVerifier — unused on these paths
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

    it("fails closed when the configured trust list is stale (NextUpdate in the past)", async () => {
        trustStore.getTrustStore.mockResolvedValue({
            entities: [],
            nextUpdate: new Date(Date.now() - 86_400_000).toISOString(),
        });

        const result = await service.validateChain(["<cert>"], LOTE_SOURCE, {});

        expect(result.verified).toBe(false);
        expect(result.error).toBe("trust_list_unavailable");
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
            service.getTrustedCertificateBuffers(LOTE_SOURCE),
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
        };
        return new CredentialChainValidationService(
            { getTrustStore: vi.fn().mockResolvedValue(store) } as any,
            new X509ValidationService(),
            {} as any,
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
});
