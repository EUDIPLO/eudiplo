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
import { isStatusListUnavailableError } from "../../../../trust/revocation-policy.util.js";
import { StatusListVerifierService } from "../../../../trust/status-list-verifier.service.js";
import { TrustFetchService } from "../../../../trust/trust-fetch.service.js";
import { OutboundUrlPolicyService } from "../../../../webhook/outbound-url-policy.service.js";
import { mdocContext } from "../../mdoc-context.js";
import { MdocverifierService } from "./mdocverifier.service.js";

const docType = "eu.europa.ec.eudi.pid.1";
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
                notAfter: new Date(Date.now() + 3_600_000),
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

    /** Status list token for `uri`, signed with the issuer's key. */
    async function signStatusListCwt(uri: string): Promise<Uint8Array> {
        const now = Math.floor(Date.now() / 1000);
        const cwt = new StatusListCwt({
            payload: {
                subject: uri,
                issuedAt: new Date((now - 60) * 1000),
                expirationTime: new Date((now + 3600) * 1000),
                timeToLive: 300,
                statusList: new StatusList([0, 0, 0, 0, 0, 0, 0, 0], 1),
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

    /** Self-signed mDOC presentation whose MSO carries `status`. */
    async function presentation(status: StatusOptions) {
        const issuer = new Issuer(docType, mdocContext);
        issuer.addIssuerNamespace(namespace, { given_name: "Erika" });
        const now = new Date();
        const validUntil = new Date(now.getTime() + 3_600_000);
        const issuerSigned = await issuer.sign({
            signingKey: CoseKey.fromJwk(issuerJwk),
            certificates: [issuerCertificate],
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

    /** Verifier without a trust list, as in the fallback described above. */
    const verifier = (
        outboundUrlPolicy: OutboundUrlPolicyService,
        publicUrl = "https://eudiplo.example",
    ) => {
        const logger = {
            setContext: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
        };
        const chainValidation = {
            getTrustedCertificateBuffers: vi.fn().mockResolvedValue([]),
            getTrustedStatusCertificateBuffers: vi.fn().mockResolvedValue([]),
            validateChain: vi
                .fn()
                .mockResolvedValue({ verified: true, matchedEntity: null }),
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
    ) => {
        const { vp, sessionTranscript } = await presentation(status);
        return service.verify(
            vp,
            { protocol: "iso-18013-7", sessionTranscript },
            {
                trustListSource: { lotes: [] },
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

    describe("best-effort revocation", () => {
        it("treats a blocked status list as unavailable, as for SD-JWT VC", async () => {
            const blocked = verifier(policy({ OUTBOUND_URL_ALLOW_HTTP: true }));
            const uri = `${loopbackIp}/status/1`;

            const strict = await verify(blocked, statusListAt(uri));
            expect(
                isStatusListUnavailableError(new Error(strict.failureReason)),
            ).toBe(true);

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
            // availability problem; the list was fetched, so it must not be
            // treated as unavailable.
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
            expect(isStatusListUnavailableError(result.failureReason)).toBe(
                true,
            );
        });
    });
});
