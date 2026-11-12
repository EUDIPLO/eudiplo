import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
    CoseKey,
    DeviceKey,
    DeviceRequest,
    DocRequest,
    Holder,
    IdentifierList,
    IdentifierListCwt,
    Issuer,
    IssuerSigned,
    ItemsRequest,
    SessionTranscript,
    SignatureAlgorithm,
    Status,
    type StatusOptions,
} from "@owf/mdoc";
import { StatusList, StatusListCwt } from "@owf/token-status-list";
import * as x509 from "@peculiar/x509";
import { exportJWK } from "jose";
import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { StatusListVerifierService } from "../../../../trust/status-list-verifier.service.js";
import { TrustFetchService } from "../../../../trust/trust-fetch.service.js";
import { ServiceTypeIdentifiers } from "../../../../trust/types.js";
import { OutboundUrlPolicyService } from "../../../../webhook/outbound-url-policy.service.js";
import { mdocContext } from "../../mdoc-context.js";
import type { MdocTrustedCertificates } from "../credential-chain-validation.service.js";
import { MdocverifierService } from "./mdocverifier.service.js";

const docType = "eu.europa.ec.eudi.pid.1";

/** A certificate and the private key it certifies, as JWK. */
type SigningCertificate = {
    jwk: Record<string, unknown>;
    certificate: Uint8Array;
};
const namespace = "eu.europa.ec.eudi.pid.1";

/** Words that read as "unavailable" when matched in an error message. */
const identifierListPath = "/revocation/network/timeout";
const revokedId = new Uint8Array([0xde, 0xad]);

/**
 * The status list URI of a presented mDOC comes from its MSO. Without a trust
 * list the presented x5chain is the trust anchor, so a wallet can present a
 * self-signed mDOC that passes chain validation and choose that URI freely.
 * These tests run the real verifier and @owf/mdoc against a local server.
 */
describe("MdocverifierService status list fetch", () => {
    let server: Server;
    let loopbackIp: string;
    let requests: string[];
    let issuerJwk: Record<string, unknown>;
    let issuerCertificate: Uint8Array;
    let deviceJwk: Record<string, unknown>;
    /** Revocation lists the server publishes, by path. */
    const published = new Map<
        string,
        { contentType: string; token: Uint8Array }
    >();

    beforeAll(async () => {
        x509.cryptoProvider.set(crypto);

        server = createServer((request, response) => {
            requests.push(request.url ?? "");
            const list = published.get(request.url ?? "");
            if (!list) {
                response.writeHead(404);
                response.end();
                return;
            }
            response.writeHead(200, { "content-type": list.contentType });
            response.end(list.token);
        });
        await new Promise<void>((resolve) =>
            server.listen(0, "127.0.0.1", resolve),
        );
        const { port } = server.address() as AddressInfo;
        loopbackIp = `http://127.0.0.1:${port}`;

        const algorithm = { name: "ECDSA", namedCurve: "P-256" };
        const issuerKeys = await crypto.subtle.generateKey(algorithm, true, [
            "sign",
            "verify",
        ]);
        const certificate =
            await x509.X509CertificateGenerator.createSelfSigned({
                serialNumber: "01",
                name: "C=DE, CN=Self-signed Wallet Issuer",
                notBefore: new Date(Date.now() - 60_000),
                // Covers the 30-day MSOs of the PID tests.
                notAfter: new Date(Date.now() + 60 * 24 * 3_600_000),
                signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
                keys: issuerKeys,
            });
        issuerJwk = (await exportJWK(issuerKeys.privateKey)) as Record<
            string,
            unknown
        >;
        issuerCertificate = new Uint8Array(certificate.rawData);

        const deviceKeys = await crypto.subtle.generateKey(algorithm, true, [
            "sign",
            "verify",
        ]);
        deviceJwk = (await exportJWK(deviceKeys.privateKey)) as Record<
            string,
            unknown
        >;

        published.set("/status/1", {
            contentType: "application/statuslist+cwt",
            token: await signStatusListCwt(`${loopbackIp}/status/1`),
        });
        published.set("/status/revoked", {
            contentType: "application/statuslist+cwt",
            token: await signStatusListCwt(`${loopbackIp}/status/revoked`, {
                statuses: [0, 1, 0, 0, 0, 0, 0, 0],
            }),
        });
        published.set("/status/oversized", {
            contentType: "application/statuslist+cwt",
            // Decompresses to 1 MiB and one byte.
            token: await signStatusListCwt(`${loopbackIp}/status/oversized`, {
                statuses: new Array<number>(1024 * 1024 + 1).fill(0),
                bits: 8,
            }),
        });
        published.set("/status/unprotected-x5chain", {
            contentType: "application/statuslist+cwt",
            token: await signStatusListCwt(
                `${loopbackIp}/status/unprotected-x5chain`,
                { unprotectedX5Chain: true },
            ),
        });
        published.set(identifierListPath, {
            contentType: "application/identifierlist+cwt",
            token: await signIdentifierListCwt(
                `${loopbackIp}${identifierListPath}`,
            ),
        });
    });

    afterAll(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    beforeEach(() => {
        requests = [];
    });

    /**
     * Status list token for `uri`, signed with the issuer's key. `statuses`
     * defaults to all valid; `unprotectedX5Chain` moves the certificate out of
     * the protected header.
     */
    async function signStatusListCwt(
        uri: string,
        {
            statuses = [0, 0, 0, 0, 0, 0, 0, 0],
            bits = 1,
            unprotectedX5Chain = false,
            signer = { jwk: issuerJwk, certificate: issuerCertificate },
        }: {
            statuses?: number[];
            bits?: 1 | 2 | 4 | 8;
            unprotectedX5Chain?: boolean;
            signer?: SigningCertificate;
        } = {},
    ): Promise<Uint8Array> {
        const now = Math.floor(Date.now() / 1000);
        const x5chain: [number, unknown] = [33, [signer.certificate]];
        const cwt = new StatusListCwt({
            payload: {
                subject: uri,
                issuedAt: new Date((now - 60) * 1000),
                expirationTime: new Date((now + 3600) * 1000),
                timeToLive: 300,
                statusList: new StatusList(statuses, bits),
            },
            protectedHeaders: new Map<number, unknown>([
                [1, SignatureAlgorithm.ES256],
                ...(unprotectedX5Chain ? [] : [x5chain]),
            ]),
            ...(unprotectedX5Chain && {
                unprotectedHeaders: new Map<number, unknown>([x5chain]),
            }),
        });
        return cwt.signAndEncode(
            {
                signingKey: CoseKey.fromJwk(signer.jwk),
                algorithm: SignatureAlgorithm.ES256,
            },
            { sign: mdocContext.cose.sign1.sign },
        );
    }

    /** Identifier list for `uri` that revokes {@link revokedId}. */
    async function signIdentifierListCwt(uri: string): Promise<Uint8Array> {
        const now = Math.floor(Date.now() / 1000);
        const cwt = new IdentifierListCwt({
            payload: {
                uri,
                issuedAt: new Date((now - 60) * 1000),
                expirationTime: new Date((now + 3600) * 1000),
                identifierList: IdentifierList.create({
                    identifiers: [revokedId],
                }),
            },
            protectedHeaders: new Map<number, unknown>([
                [1, SignatureAlgorithm.ES256],
                [33, [issuerCertificate]],
            ]),
        });
        return cwt.signAndEncode(
            {
                signingKey: CoseKey.fromJwk(issuerJwk),
                algorithm: SignatureAlgorithm.ES256,
            },
            { sign: mdocContext.cose.sign1.sign },
        );
    }

    /**
     * mDOC presentation whose MSO carries `status`, signed by the self-signed
     * issuer certificate unless `signer` is given.
     */
    async function presentation(
        status: StatusOptions | undefined,
        signer: SigningCertificate = {
            jwk: issuerJwk,
            certificate: issuerCertificate,
        },
        validForMs = 3_600_000,
    ) {
        const issuer = new Issuer(docType, mdocContext);
        issuer.addIssuerNamespace(namespace, { given_name: "Erika" });
        const now = new Date();
        const validUntil = new Date(now.getTime() + validForMs);
        const issuerSigned = await issuer.sign({
            signingKey: CoseKey.fromJwk(signer.jwk),
            certificates: [signer.certificate],
            algorithm: SignatureAlgorithm.ES256,
            digestAlgorithm: "SHA-256",
            deviceKeyInfo: { deviceKey: DeviceKey.fromJwk(deviceJwk) },
            validityInfo: { signed: now, validFrom: now, validUntil },
            status,
        });

        const sessionTranscript = await SessionTranscript.forOid4Vp(
            {
                clientId: "x509_san_dns:eudiplo.example",
                responseUri: "https://eudiplo.example/response",
                nonce: "nonce",
            },
            mdocContext,
        );
        const deviceResponse =
            await Holder.createDeviceResponseForDeviceRequest(
                {
                    deviceRequest: DeviceRequest.create({
                        docRequests: [
                            DocRequest.create({
                                itemsRequest: ItemsRequest.create({
                                    docType,
                                    namespaces: {
                                        [namespace]: { given_name: true },
                                    },
                                }),
                            }),
                        ],
                    }),
                    sessionTranscript,
                    documents: [
                        {
                            docRequestIndex: 0,
                            issuerSigned: IssuerSigned.fromEncodedForOid4Vci(
                                issuerSigned.encodedForOid4Vci,
                            ),
                            signature: {
                                signingKey: CoseKey.fromJwk({
                                    ...deviceJwk,
                                    alg: "ES256",
                                }),
                            },
                        },
                    ],
                },
                mdocContext,
            );

        return {
            vp: deviceResponse.encodedForOid4Vp,
            sessionTranscript,
        };
    }

    const statusListAt = (uri: string): StatusOptions => ({
        statusList: { idx: 1, uri },
    });

    const identifierListAt = (
        uri: string,
        id = new Uint8Array([0x01]),
    ): StatusOptions => ({
        identifierList: { id, uri },
    });

    /** Policy with the 9.0 defaults: HTTPS only, no private addresses. */
    const policy = (config: Record<string, boolean> = {}) =>
        new OutboundUrlPolicyService({
            get: vi.fn(
                (key: string, fallback?: unknown) => config[key] ?? fallback,
            ),
        } as never);

    /**
     * Verifier without a trust list, as in the fallback described above, or
     * with the trust anchor entries a trust list gives.
     */
    const verifier = (
        outboundUrlPolicy: OutboundUrlPolicyService,
        publicUrl = "https://eudiplo.example",
        trustedEntries: MdocTrustedCertificates[] = [],
        /** Trust list service type the issuer chain matches, if any. */
        issuanceServiceType?: string,
        /** Whether the chain also matches a PID issuance service. */
        pidIssuer = issuanceServiceType === ServiceTypeIdentifiers.PIDIssuance,
    ) => {
        const logger = {
            setContext: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
        };
        const chainValidation = {
            getTrustedCertificateEntries: vi
                .fn()
                .mockResolvedValue(trustedEntries),
            validateChain: vi.fn().mockResolvedValue({
                verified: true,
                pidIssuer,
                matchedEntity: issuanceServiceType
                    ? {
                          entity: { entityId: "issuer" },
                          issuanceServiceType,
                          matchMode: "leaf-pinned",
                      }
                    : null,
            }),
            discardedTrustListsDetail: vi.fn().mockResolvedValue(undefined),
        };
        const statusLists = new StatusListVerifierService(
            new TrustFetchService(outboundUrlPolicy, { publicUrl }),
        );
        return new MdocverifierService(
            chainValidation as never,
            statusLists,
            logger as never,
        );
    };

    const verify = async (
        service: MdocverifierService,
        status: StatusOptions,
        failClosed = true,
        signer?: SigningCertificate,
    ) => {
        const { vp, sessionTranscript } = await presentation(status, signer);
        return service.verify(
            vp,
            { protocol: "iso-18013-7", sessionTranscript },
            {
                trustListSource: { lotes: [], tenantId: "tenant-a" },
                policy: { revocation: { enabled: true, failClosed } },
            } as never,
            [[namespace, "given_name"]],
        );
    };

    it("does not fetch a status list on a private address", async () => {
        const result = await verify(
            verifier(policy({ OUTBOUND_URL_ALLOW_HTTP: true })),
            statusListAt(`${loopbackIp}/status/1`),
        );

        expect(result.verified).toBe(false);
        expect(result.failureReason).toContain("private or loopback IP");
        expect(requests).toEqual([]);
    });

    it("fetches it when OUTBOUND_URL_ALLOW_PRIVATE_NETWORK is set", async () => {
        const result = await verify(
            verifier(
                policy({
                    OUTBOUND_URL_ALLOW_HTTP: true,
                    OUTBOUND_URL_ALLOW_PRIVATE_NETWORK: true,
                }),
            ),
            statusListAt(`${loopbackIp}/status/1`),
        );

        expect(result).toMatchObject({ verified: true });
        expect(requests).toEqual(["/status/1"]);
    });

    it("fetches a status list on EUDIPLO's own PUBLIC_URL", async () => {
        const result = await verify(
            verifier(policy(), `${loopbackIp}/`),
            statusListAt(`${loopbackIp}/status/1`),
        );

        expect(result).toMatchObject({ verified: true });
        expect(requests).toEqual(["/status/1"]);
    });

    it("serves the status list from the cache", async () => {
        const service = verifier(policy(), loopbackIp);

        await expect(
            verify(service, statusListAt(`${loopbackIp}/status/1`)),
        ).resolves.toMatchObject({ verified: true });
        await expect(
            verify(service, statusListAt(`${loopbackIp}/status/1`)),
        ).resolves.toMatchObject({ verified: true });
        expect(requests).toEqual(["/status/1"]);

        // Recorded for the tenant of the presentation.
        const statusLists = (
            service as unknown as {
                statusListVerifier: StatusListVerifierService;
            }
        ).statusListVerifier;
        expect(statusLists.getCacheStats("tenant-a").uris).toEqual([
            `${loopbackIp}/status/1`,
        ]);
        expect(statusLists.getCacheStats("tenant-b").uris).toEqual([]);
        statusLists.clearTenantCache("tenant-a");
        expect(statusLists.getCacheStats().uris).toEqual([]);
    });

    it("rejects a credential its status list revokes", async () => {
        const service = verifier(policy(), loopbackIp);
        const uri = `${loopbackIp}/status/revoked`;

        for (const failClosed of [true, false]) {
            const result = await verify(service, statusListAt(uri), failClosed);
            expect(result.verified).toBe(false);
            expect(result.failureReason).toContain("is not Valid");
        }
    });

    // RP_PP_SM_Revocation_016b_UF of the RP conformance suite.
    it("rejects a status list that decompresses to more than 1 MiB before the library reads it", async () => {
        const service = verifier(policy(), loopbackIp);
        const uri = `${loopbackIp}/status/oversized`;
        const libraryDecompress = vi.spyOn(
            StatusList,
            "decompressStatusListFromBytes",
        );

        try {
            for (const failClosed of [true, false]) {
                const result = await verify(
                    service,
                    statusListAt(uri),
                    failClosed,
                );
                expect(result).toMatchObject({
                    verified: false,
                    failureType: "verification_error",
                    failureReason: expect.stringContaining(
                        "cannot be decompressed",
                    ),
                });
            }
            expect(libraryDecompress).not.toHaveBeenCalled();
        } finally {
            libraryDecompress.mockRestore();
        }
    });

    it("rejects a status list whose x5chain is only in the unprotected header", async () => {
        const result = await verify(
            verifier(policy(), loopbackIp),
            statusListAt(`${loopbackIp}/status/unprotected-x5chain`),
        );

        expect(result.verified).toBe(false);
        expect(result.failureReason).toContain("unprotected header");
        expect(requests).toEqual(["/status/unprotected-x5chain"]);
    });

    /**
     * With a trust list, @owf/mdoc checks the status list against the status
     * anchors of the entry whose issuance anchor the credential chain ends
     * at. Issuers here are listed as CAs, so that anchor is not the document
     * signer.
     */
    describe("status list signer paired with the issuer", () => {
        const keyAlgorithm = { name: "ECDSA", namedCurve: "P-256" };
        const signingAlgorithm = { name: "ECDSA", hash: "SHA-256" };
        let serial = 10;
        type Issued = SigningCertificate & {
            cert: x509.X509Certificate;
            keys: CryptoKeyPair;
        };

        async function keyPair(): Promise<CryptoKeyPair> {
            return (await crypto.subtle.generateKey(keyAlgorithm, true, [
                "sign",
                "verify",
            ])) as CryptoKeyPair;
        }

        async function issued(
            cert: x509.X509Certificate,
            keys: CryptoKeyPair,
        ): Promise<Issued> {
            return {
                cert,
                keys,
                certificate: new Uint8Array(cert.rawData),
                jwk: (await exportJWK(keys.privateKey)) as Record<
                    string,
                    unknown
                >,
            };
        }

        async function ca(
            name: string,
            {
                notBefore = new Date(Date.now() - 60_000),
                notAfter = new Date(Date.now() + 3_600_000),
            }: { notBefore?: Date; notAfter?: Date } = {},
        ): Promise<Issued> {
            const keys = await keyPair();
            const cert = await x509.X509CertificateGenerator.createSelfSigned({
                serialNumber: String(serial++),
                name: `C=DE, CN=${name}`,
                notBefore,
                notAfter,
                signingAlgorithm,
                keys,
                extensions: [
                    new x509.BasicConstraintsExtension(true, undefined, true),
                ],
            });
            return issued(cert, keys);
        }

        async function issuedBy(
            parent: Issued,
            name: string,
            {
                notBefore = new Date(Date.now() - 60_000),
                notAfter = new Date(Date.now() + 3_600_000),
            }: { notBefore?: Date; notAfter?: Date } = {},
        ): Promise<Issued> {
            const keys = await keyPair();
            const cert = await x509.X509CertificateGenerator.create({
                serialNumber: String(serial++),
                subject: `C=DE, CN=${name}`,
                issuer: parent.cert.subject,
                notBefore,
                notAfter,
                signingAlgorithm,
                publicKey: keys.publicKey,
                signingKey: parent.keys.privateKey,
            });
            return issued(cert, keys);
        }

        let documentSigner: Issued;
        let issuerCa: Issued;
        let revocationCa: Issued;
        let otherCa: Issued;
        let otherRevocationCa: Issued;
        let entries: MdocTrustedCertificates[];

        beforeAll(async () => {
            issuerCa = await ca("PID Provider CA");
            revocationCa = await ca("PID Provider Status CA");
            otherCa = await ca("Other Provider CA");
            otherRevocationCa = await ca("Other Provider Status CA");
            documentSigner = await issuedBy(issuerCa, "PID Document Signer");
            entries = [
                {
                    issuance: [issuerCa.certificate],
                    status: [revocationCa.certificate],
                },
                {
                    issuance: [otherCa.certificate],
                    status: [otherRevocationCa.certificate],
                },
            ];

            published.set("/status/paired", {
                contentType: "application/statuslist+cwt",
                token: await signStatusListCwt(`${loopbackIp}/status/paired`, {
                    signer: await issuedBy(revocationCa, "PID Status Signer"),
                }),
            });
            published.set("/status/expired-signer", {
                contentType: "application/statuslist+cwt",
                token: await signStatusListCwt(
                    `${loopbackIp}/status/expired-signer`,
                    {
                        signer: await issuedBy(
                            revocationCa,
                            "Expired Status Signer",
                            {
                                notBefore: new Date(Date.now() - 7_200_000),
                                notAfter: new Date(Date.now() - 3_600_000),
                            },
                        ),
                    },
                ),
            });
            published.set("/status/future-signer", {
                contentType: "application/statuslist+cwt",
                token: await signStatusListCwt(
                    `${loopbackIp}/status/future-signer`,
                    {
                        signer: await issuedBy(
                            revocationCa,
                            "Future Status Signer",
                            {
                                notBefore: new Date(Date.now() + 3_600_000),
                                notAfter: new Date(Date.now() + 7_200_000),
                            },
                        ),
                    },
                ),
            });
            published.set("/status/other-issuer", {
                contentType: "application/statuslist+cwt",
                token: await signStatusListCwt(
                    `${loopbackIp}/status/other-issuer`,
                    {
                        signer: await issuedBy(
                            otherRevocationCa,
                            "Other Status Signer",
                        ),
                    },
                ),
            });
        });

        it("accepts a status list signed under the issuer's revocation CA", async () => {
            const result = await verify(
                verifier(policy(), loopbackIp, entries),
                statusListAt(`${loopbackIp}/status/paired`),
                true,
                documentSigner,
            );

            expect(result).toMatchObject({ verified: true });
            expect(requests).toEqual(["/status/paired"]);
        });

        it.each([
            ["expired", "expired-signer", "Certificate has expired"],
            ["not yet valid", "future-signer", "Certificate is not yet valid"],
        ])(
            "rejects a status list whose signer certificate is %s, also in best-effort mode",
            async (_validity, path, reason) => {
                const service = verifier(policy(), loopbackIp, entries);

                // The list was fetched, so it does not count as unavailable.
                for (const failClosed of [true, false]) {
                    const result = await verify(
                        service,
                        statusListAt(`${loopbackIp}/status/${path}`),
                        failClosed,
                        documentSigner,
                    );

                    expect(result).toMatchObject({
                        verified: false,
                        failureType: "certificate_expired",
                    });
                    expect(result.failureReason).toContain(reason);
                }
                expect(requests).toContain(`/status/${path}`);
            },
        );

        it("rejects a status list signed under a listed revocation CA that has expired, also in best-effort mode", async () => {
            const expiredRevocationCa = await ca("Expired PID Status CA", {
                notBefore: new Date(Date.now() - 7_200_000),
                notAfter: new Date(Date.now() - 3_600_000),
            });
            published.set("/status/expired-anchor", {
                contentType: "application/statuslist+cwt",
                token: await signStatusListCwt(
                    `${loopbackIp}/status/expired-anchor`,
                    {
                        signer: await issuedBy(
                            expiredRevocationCa,
                            "PID Status Signer",
                        ),
                    },
                ),
            });
            const service = verifier(policy(), loopbackIp, [
                {
                    issuance: [issuerCa.certificate],
                    status: [expiredRevocationCa.certificate],
                },
            ]);

            for (const failClosed of [true, false]) {
                const result = await verify(
                    service,
                    statusListAt(`${loopbackIp}/status/expired-anchor`),
                    failClosed,
                    documentSigner,
                );

                expect(result).toMatchObject({
                    verified: false,
                    failureType: "certificate_expired",
                });
                expect(result.failureReason).toMatch(
                    /index=0\..*Certificate has expired/,
                );
            }
        });

        it("rejects a credential whose document signer certificate has expired", async () => {
            const expiredSigner = await issuedBy(
                issuerCa,
                "Expired Document Signer",
                {
                    notBefore: new Date(Date.now() - 7_200_000),
                    notAfter: new Date(Date.now() - 3_600_000),
                },
            );

            const result = await verify(
                verifier(policy(), loopbackIp, entries),
                statusListAt(`${loopbackIp}/status/paired`),
                true,
                expiredSigner,
            );

            expect(result).toMatchObject({
                verified: false,
                failureType: "certificate_expired",
            });
            expect(result.failureReason).toContain("Certificate has expired");
            expect(requests).toEqual([]);
        });

        it("rejects an expired self-signed issuer certificate without a trust list", async () => {
            // Without trust list entries the presented x5chain is the
            // anchor; its validity period is still checked.
            const expiredIssuer = await ca("Expired Self-signed Issuer", {
                notBefore: new Date(Date.now() - 7_200_000),
                notAfter: new Date(Date.now() - 3_600_000),
            });

            const result = await verify(
                verifier(policy(), loopbackIp),
                statusListAt(`${loopbackIp}/status/1`),
                true,
                expiredIssuer,
            );

            expect(result).toMatchObject({
                verified: false,
                failureType: "certificate_expired",
            });
            expect(result.failureReason).toContain("Certificate has expired");
            expect(requests).toEqual([]);
        });

        it("rejects a status list signed under another issuer's revocation CA", async () => {
            const result = await verify(
                verifier(policy(), loopbackIp, entries),
                statusListAt(`${loopbackIp}/status/other-issuer`),
                true,
                documentSigner,
            );

            expect(result.verified).toBe(false);
            expect(result.failureReason).toContain("No trusted certificate");
            expect(requests).toEqual(["/status/other-issuer"]);
        });

        it("rejects another issuer's status list for a pinned document signer", async () => {
            // The self-signed issuer certificate is listed itself, so the
            // credential chain ends at the document signer.
            const result = await verify(
                verifier(policy(), loopbackIp, [
                    {
                        issuance: [issuerCertificate],
                        status: [revocationCa.certificate],
                    },
                    {
                        issuance: [otherCa.certificate],
                        status: [otherRevocationCa.certificate],
                    },
                ]),
                statusListAt(`${loopbackIp}/status/other-issuer`),
            );

            expect(result.verified).toBe(false);
            expect(result.failureReason).toContain("No trusted certificate");
        });

        it("rejects every status list of an issuer without status signers", async () => {
            // No fallback to the issuance anchor: the issuer CA could
            // otherwise sign its own status lists.
            const result = await verify(
                verifier(policy(), loopbackIp, [
                    { issuance: [issuerCa.certificate], status: [] },
                ]),
                statusListAt(`${loopbackIp}/status/paired`),
                true,
                documentSigner,
            );

            expect(result.verified).toBe(false);
            expect(result.failureReason).toContain("Atleast one certificate");
            expect(requests).toEqual([]);
        });
    });

    describe("identifier lists", () => {
        const uri = () => `${loopbackIp}${identifierListPath}`;

        it("does not fetch an identifier list on a private address", async () => {
            const result = await verify(
                verifier(policy({ OUTBOUND_URL_ALLOW_HTTP: true })),
                identifierListAt(uri()),
            );

            expect(result.verified).toBe(false);
            expect(result.failureReason).toContain("private or loopback IP");
            expect(requests).toEqual([]);
        });

        it("checks an identifier list on EUDIPLO's own PUBLIC_URL", async () => {
            const service = verifier(policy(), loopbackIp);

            await expect(
                verify(service, identifierListAt(uri())),
            ).resolves.toMatchObject({ verified: true });
            await expect(
                verify(service, identifierListAt(uri(), revokedId)),
            ).resolves.toMatchObject({ verified: false });
            expect(requests).toEqual([identifierListPath, identifierListPath]);
        });
    });

    // RP_WS_SM_Revocation_005a_UF of the RP conformance suite, for mDOCs.
    describe("malformed status references", () => {
        // CBOR of the text strings "idx" and "uri", and of the integer 1.
        const IDX = [0x63, 0x69, 0x64, 0x78];
        const URI = [0x63, 0x75, 0x72, 0x69];

        /**
         * `vp` with `from` replaced by `to` of the same length. Neither
         * @owf/token-status-list nor the holder creates a malformed status
         * reference, so it is written into the presented bytes. That breaks
         * the MSO signature, but @owf/mdoc decodes the reference first.
         */
        const patched = (vp: string, from: number[], to: number[]) => {
            const bytes = Buffer.from(vp, "base64url");
            const at = bytes.indexOf(Buffer.from(from));
            expect(at).toBeGreaterThan(-1);
            Buffer.from(to).copy(bytes, at);
            return bytes.toString("base64url");
        };

        it.each([
            ["no idx", [...IDX, 0x01], [0x63, 0x69, 0x64, 0x79, 0x01]],
            ["no uri", URI, [0x63, 0x75, 0x72, 0x6a]],
            ["a negative idx", [...IDX, 0x01], [...IDX, 0x20]],
            ["a string idx", [...IDX, 0x01], [...IDX, 0x60]],
        ])("rejects a status list reference with %s", async (_, from, to) => {
            const service = verifier(policy(), loopbackIp);
            const { vp, sessionTranscript } = await presentation(
                statusListAt(`${loopbackIp}/status/1`),
            );

            for (const failClosed of [true, false]) {
                const result = await service.verify(
                    patched(vp, from, to),
                    { protocol: "iso-18013-7", sessionTranscript },
                    {
                        trustListSource: { lotes: [] },
                        policy: { revocation: { enabled: true, failClosed } },
                    } as never,
                    [[namespace, "given_name"]],
                );
                expect(result.verified).toBe(false);
                expect(result.failureReason).toContain(
                    "Error decoding StatusListInfo",
                );
            }
            expect(requests).toEqual([]);
        });

        it.each([
            ["a status list", statusListAt("not a uri")],
            ["an identifier list", identifierListAt("not a uri")],
        ])(
            "rejects %s uri that is not a URI without fetching it",
            async (_, status) => {
                const service = verifier(policy(), loopbackIp);
                const get = vi.spyOn(TrustFetchService.prototype, "get");

                try {
                    for (const failClosed of [true, false]) {
                        const result = await verify(
                            service,
                            status,
                            failClosed,
                        );
                        expect(result).toMatchObject({
                            verified: false,
                            failureType: "verification_error",
                            failureReason: expect.stringContaining(
                                "not an absolute URI",
                            ),
                        });
                    }
                    expect(get).not.toHaveBeenCalled();
                } finally {
                    get.mockRestore();
                }
            },
        );
    });

    describe("MSO status without a status list or identifier list", () => {
        it("rejects an empty one in strict and best-effort mode", async () => {
            const service = verifier(policy(), loopbackIp);

            for (const failClosed of [true, false]) {
                const result = await verify(
                    service,
                    Status.create({}) as never,
                    failClosed,
                );
                expect(result).toMatchObject({
                    verified: false,
                    failureType: "verification_error",
                    failureReason: "The MSO's status names no status mechanism",
                });
            }
        });

        it("rejects one with only another mechanism in strict mode only", async () => {
            const service = verifier(policy(), loopbackIp);
            const otherMechanism = () =>
                Status.fromEncodedStructure(
                    new Map([["other_mechanism", { id: 1 }]]),
                ) as never;

            await expect(
                verify(service, otherMechanism(), true),
            ).resolves.toMatchObject({
                verified: false,
                failureType: "verification_error",
                failureReason: expect.stringContaining(
                    "no supported status mechanism",
                ),
            });
            await expect(
                verify(service, otherMechanism(), false),
            ).resolves.toMatchObject({ verified: true });
        });
    });

    // RP_WS_SM_Revocation_008b_UF of the RP conformance suite: a PID valid
    // for more than 24 hours needs status information (ARF Annex 2 VCR_01).
    describe("PID without status", () => {
        const DAY_MS = 24 * 3_600_000;
        const PID = ServiceTypeIdentifiers.PIDIssuance;
        const EAA = ServiceTypeIdentifiers.EaaIssuance;
        const BEST_EFFORT_WARNING = expect.stringContaining(
            "accepting it in best-effort mode",
        );

        /** Verify an mDOC of an issuer the chain check reports as listed. */
        const verifyMdoc = async ({
            issuanceServiceType = PID,
            pidIssuer,
            validForMs = 30 * DAY_MS,
            status,
            enabled = true,
            failClosed = true,
        }: {
            issuanceServiceType?: string;
            pidIssuer?: boolean;
            validForMs?: number;
            status?: StatusOptions;
            enabled?: boolean;
            failClosed?: boolean;
        } = {}) => {
            const service = verifier(
                policy(),
                loopbackIp,
                [],
                issuanceServiceType,
                pidIssuer,
            );
            const { vp, sessionTranscript } = await presentation(
                status,
                undefined,
                validForMs,
            );
            const result = await service.verify(
                vp,
                { protocol: "iso-18013-7", sessionTranscript },
                {
                    trustListSource: { lotes: [] },
                    policy: { revocation: { enabled, failClosed } },
                } as never,
                [[namespace, "given_name"]],
            );
            const { logger } = service as unknown as {
                logger: { warn: ReturnType<typeof vi.fn> };
            };
            return { result, logger };
        };

        it("rejects a PID valid for 30 days in strict mode", async () => {
            const { result } = await verifyMdoc();

            expect(result).toMatchObject({
                verified: false,
                failureType: "verification_error",
                failureReason: expect.stringMatching(
                    /PID carries no status information/,
                ),
            });
        });

        it("accepts it with a warning in best-effort mode", async () => {
            const { result, logger } = await verifyMdoc({ failClosed: false });

            expect(result).toMatchObject({ verified: true });
            expect(logger.warn).toHaveBeenCalledWith(BEST_EFFORT_WARNING);
        });

        it("does not check it when the status check is disabled", async () => {
            const { result, logger } = await verifyMdoc({
                enabled: false,
                failClosed: false,
            });

            expect(result).toMatchObject({ verified: true });
            expect(logger.warn).not.toHaveBeenCalledWith(BEST_EFFORT_WARNING);
        });

        it("rejects an mDOC whose certificate is also listed as PID issuer", async () => {
            const { result } = await verifyMdoc({
                issuanceServiceType: EAA,
                pidIssuer: true,
            });

            expect(result).toMatchObject({
                verified: false,
                failureType: "verification_error",
            });
        });

        it("accepts a PID valid for 30 days with a status list", async () => {
            const { result } = await verifyMdoc({
                status: statusListAt(`${loopbackIp}/status/1`),
            });

            expect(result).toMatchObject({ verified: true });
        });

        it("accepts a PID valid for 24 hours", async () => {
            const { result } = await verifyMdoc({ validForMs: DAY_MS });

            expect(result).toMatchObject({ verified: true });
        });

        it("accepts an EAA valid for 30 days", async () => {
            const { result } = await verifyMdoc({ issuanceServiceType: EAA });

            expect(result).toMatchObject({ verified: true });
        });
    });

    describe("best-effort revocation", () => {
        it("treats a blocked status list as unavailable, as for SD-JWT VC", async () => {
            const blocked = verifier(policy({ OUTBOUND_URL_ALLOW_HTTP: true }));
            const uri = `${loopbackIp}/status/1`;

            await expect(
                verify(blocked, statusListAt(uri)),
            ).resolves.toMatchObject({ verified: false });

            await expect(
                verify(blocked, statusListAt(uri), false),
            ).resolves.toMatchObject({ verified: true });
            expect(requests).toEqual([]);
        });

        it("treats a blocked identifier list as unavailable", async () => {
            await expect(
                verify(
                    verifier(policy({ OUTBOUND_URL_ALLOW_HTTP: true })),
                    identifierListAt(`${loopbackIp}/identifiers/1`),
                    false,
                ),
            ).resolves.toMatchObject({ verified: true });
            expect(requests).toEqual([]);
        });

        it("rejects a credential its identifier list revokes", async () => {
            // The error names the list's URI, which here reads like an
            // availability problem. The list was fetched, so best-effort mode
            // must not treat it as unavailable.
            const result = await verify(
                verifier(policy(), loopbackIp),
                identifierListAt(
                    `${loopbackIp}${identifierListPath}`,
                    revokedId,
                ),
                false,
            );

            expect(result.verified).toBe(false);
            expect(result.failureReason).toContain(
                "found in the revoked identifier list",
            );
        });
    });
});
