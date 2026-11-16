import "reflect-metadata";
import { createHash, randomUUID } from "node:crypto";
import { INestApplication } from "@nestjs/common";
import {
    Openid4vpAuthorizationRequest,
    Openid4vpClient,
} from "@openid4vc/openid4vp";
import { StatusList } from "@owf/token-status-list";
import { X509CertificateGenerator } from "@peculiar/x509";
import { base64url, importPKCS8, SignJWT } from "jose";
import nock from "nock";
import request from "supertest";
import { App } from "supertest/types";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { StatusListService } from "../../src/issuer/status-list/status-list.service.js";
import { ResponseType } from "../../src/verifier/oid4vp/dto/presentation-request.dto.js";
import {
    createMockTrustListJwt,
    generateSelfSignedCertificate,
} from "../issuance/attestation-trust-helpers.js";
import {
    buildSignedTrustedList,
    EAA_SERVICE_TYPE,
    SERVICE_STATUS,
    TSL_TYPE,
} from "../trust/trusted-list.fixture.js";
import {
    callbacks,
    createPresentationRequest,
    createTestFetch,
    encryptVpToken,
    prepareMdocPresentation,
    preparePresentation,
    setupPresentationTestApp,
} from "../utils.js";

type Signer = Awaited<ReturnType<typeof generateSelfSignedCertificate>>;

/**
 * A QTSP's self-signed certificate, valid for a year. mdoc issuer
 * certificates must name a country (ISO/IEC 18013-5 Annex B).
 */
async function qtspCertificate(name: string): Promise<Signer> {
    const keys = await globalThis.crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["sign", "verify"],
    );
    const certificate = await X509CertificateGenerator.createSelfSigned(
        {
            serialNumber: "01",
            name: `C=DE, CN=${name}`,
            notBefore: new Date(),
            notAfter: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
            signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
            keys,
        },
        globalThis.crypto,
    );
    return { certificate, ...keys };
}

const HOST = "http://localhost:8787";
const VCT = "urn:eudiplo:test:qeaa:1";
const DOCTYPE = "test.eudiplo.qeaa.1";
const PID_ISSUANCE = "http://uri.etsi.org/19602/SvcType/PID/Issuance";
const QC_CA = "http://uri.etsi.org/TrstSvc/Svctype/CA/QC";

/**
 * QEAAs are trusted through the granted qualified service of their QTSP in an
 * ETSI TS 119 612 Trusted List, reached through a list of trusted lists
 * (ARF Annex 2 OIA_13, OIA_15b), as `RP_WS_SM_TrustMechanisms_010` and `_011`
 * of the RP conformance suite test it. Anchors keep their category (OIA_15
 * note): a QTSP never issues a PID, a PID provider never a QEAA.
 */
describe("Presentation - QEAA trusted through an ETSI TS 119 612 Trusted List", () => {
    let app: INestApplication<App>;
    let authToken: string;
    let host: string;
    let client: Openid4vpClient;
    let lotlSigner: Signer;
    let tlSigner: Signer;
    /** QTSPs: granted, granted, not qualified, withdrawn. */
    let qpA: Signer;
    let qpB: Signer;
    let qpN: Signer;
    let qpW: Signer;
    let pidProvider: Signer;
    const run = randomUUID();
    const lotlUrl = `${HOST}/lotl-${run}.xml`;
    const tlUrl = `${HOST}/tl-qeaa-${run}.xml`;
    const configs = {
        lotl: `qeaa-lotl-${run}`,
        tl: `qeaa-tl-${run}`,
        forged: `qeaa-forged-${run}`,
        pid: `pid-lote-${run}`,
        loteQeaa: `qeaa-lote-${run}`,
        mdoc: `qeaa-mdoc-${run}`,
    };
    const der = (signer: Signer) => signer.certificate.toString("base64");

    /** A presentation config with one credential query trusting `value`. */
    async function createConfig(
        id: string,
        value: Record<string, unknown>,
        format: "dc+sd-jwt" | "mso_mdoc" = "dc+sd-jwt",
    ) {
        const query =
            format === "dc+sd-jwt"
                ? {
                      id: "credential",
                      format,
                      meta: { vct_values: [VCT] },
                      claims: [{ path: ["address", "locality"] }],
                  }
                : {
                      id: "credential",
                      format,
                      meta: { doctype_value: DOCTYPE },
                      claims: [
                          {
                              path: [DOCTYPE, "given_name"],
                              intent_to_retain: false,
                          },
                      ],
                  };
        await request(app.getHttpServer())
            .post("/verifier/config")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                id,
                description: id,
                dcql_query: {
                    credentials: [
                        {
                            ...query,
                            trusted_authorities: [
                                { type: "etsi_tl", values: [value] },
                            ],
                        },
                    ],
                },
            })
            .expect(201);
    }

    beforeAll(async () => {
        const ctx = await setupPresentationTestApp();
        app = ctx.app;
        authToken = ctx.authToken;
        host = ctx.host;
        client = new Openid4vpClient({
            callbacks: {
                ...callbacks,
                fetch: createTestFetch(app, () => host),
            },
        });
        [lotlSigner, tlSigner, pidProvider] = await Promise.all(
            Array.from({ length: 3 }, () => generateSelfSignedCertificate()),
        );
        [qpA, qpB, qpN, qpW] = await Promise.all(
            ["QP-A", "QP-B", "QP-N", "QP-W"].map(qtspCertificate),
        );
        const pidListSigner = await generateSelfSignedCertificate();

        const lotl = await buildSignedTrustedList(
            {
                tslType: TSL_TYPE.EUlistofthelists,
                territory: "EU",
                pointers: [
                    { location: tlUrl, signers: [tlSigner.certificate] },
                    // A national list that cannot be loaded is left out on
                    // its own; the others still count.
                    {
                        location: `${HOST}/tl-fr-${run}.xml`,
                        signers: [tlSigner.certificate],
                        territory: "FR",
                    },
                    {
                        location: lotlUrl,
                        signers: [lotlSigner.certificate],
                        tslType: TSL_TYPE.EUlistofthelists,
                        territory: "EU",
                    },
                ],
            },
            lotlSigner,
        );
        const tl = await buildSignedTrustedList(
            {
                pointers: [
                    {
                        location: lotlUrl,
                        signers: [lotlSigner.certificate],
                        tslType: TSL_TYPE.EUlistofthelists,
                        territory: "EU",
                    },
                ],
                providers: [
                    {
                        name: "QP-A",
                        services: [{ certificates: [qpA.certificate] }],
                    },
                    {
                        name: "QP-B",
                        services: [{ certificates: [qpB.certificate] }],
                    },
                    {
                        name: "QP-N",
                        services: [
                            {
                                certificates: [qpN.certificate],
                                type: EAA_SERVICE_TYPE.notQualified,
                                status: SERVICE_STATUS.recognisedAtNationalLevel,
                            },
                        ],
                    },
                    {
                        name: "QP-W",
                        services: [
                            {
                                certificates: [qpW.certificate],
                                status: SERVICE_STATUS.withdrawn,
                            },
                        ],
                    },
                    // A granted qualified service of another type.
                    {
                        name: "PP-A as QTSP",
                        services: [
                            {
                                certificates: [pidProvider.certificate],
                                type: QC_CA,
                            },
                        ],
                    },
                ],
            },
            tlSigner,
        );
        const scope = nock(HOST).persist();
        scope.get(`/lotl-${run}.xml`).reply(200, lotl, {
            "Content-Type": "application/vnd.etsi.tsl+xml",
        });
        scope.get(`/tl-qeaa-${run}.xml`).reply(200, tl, {
            "Content-Type": "application/vnd.etsi.tsl+xml",
        });
        scope.get(`/tl-fr-${run}.xml`).reply(404);
        scope
            .get(`/tl-pid-${run}.jwt`)
            .reply(
                200,
                await createMockTrustListJwt(
                    pidListSigner,
                    pidProvider.certificate,
                    { serviceTypeIdentifier: PID_ISSUANCE },
                ),
                { "Content-Type": "application/jwt" },
            );
        // A LoTE that lists a QTSP with the TS 119 612 QEAA service type.
        scope.get(`/lote-qeaa-${run}.jwt`).reply(
            200,
            await createMockTrustListJwt(pidListSigner, qpA.certificate, {
                serviceTypeIdentifier: EAA_SERVICE_TYPE.qualified,
            }),
            { "Content-Type": "application/jwt" },
        );

        await createConfig(configs.lotl, {
            format: "trusted-list",
            url: lotlUrl,
            signingCertificates: [der(lotlSigner)],
        });
        await createConfig(configs.tl, {
            format: "trusted-list",
            url: tlUrl,
            signingCertificates: [der(tlSigner)],
        });
        await createConfig(configs.forged, {
            format: "trusted-list",
            url: lotlUrl,
            signingCertificates: [der(tlSigner)],
        });
        await createConfig(configs.pid, {
            url: `${HOST}/tl-pid-${run}.jwt`,
            verifierX509Der: der(pidListSigner),
        });
        await createConfig(configs.loteQeaa, {
            url: `${HOST}/lote-qeaa-${run}.jwt`,
            verifierX509Der: der(pidListSigner),
        });
        await createConfig(
            configs.mdoc,
            {
                format: "trusted-list",
                url: lotlUrl,
                signingCertificates: [der(lotlSigner)],
                schemeTerritories: ["de"],
            },
            "mso_mdoc",
        );
    });

    afterEach(() => {
        nock.abortPendingRequests();
    });

    afterAll(async () => {
        nock.cleanAll();
        await app?.close();
    });

    /** Status list JWT for `uri` in which every status is valid. */
    async function statusListJwt(signer: Signer, uri: string) {
        const key = await importPKCS8(
            "-----BEGIN PRIVATE KEY-----\n" +
                Buffer.from(
                    await globalThis.crypto.subtle.exportKey(
                        "pkcs8",
                        signer.privateKey,
                    ),
                ).toString("base64") +
                "\n-----END PRIVATE KEY-----",
            "ES256",
        );
        const list = new StatusList(new Array(16).fill(0), 1);
        return new SignJWT({
            sub: uri,
            status_list: {
                bits: 1,
                lst: base64url.encode(list.compressStatusListToBytes()),
            },
        })
            .setProtectedHeader({
                alg: "ES256",
                typ: "statuslist+jwt",
                x5c: [der(signer)],
            })
            .setIssuedAt()
            .setExpirationTime("1h")
            .sign(key);
    }

    /** Start a presentation of the config and resolve its request. */
    async function start(requestId: string) {
        const res = await createPresentationRequest(app, authToken, {
            response_type: ResponseType.URI,
            requestId,
        });
        const authRequest = client.parseOpenid4vpAuthorizationRequest({
            authorizationRequest: res.body.uri,
        });
        const resolved = await client.resolveOpenid4vpAuthorizationRequest({
            authorizationRequestPayload: authRequest.params,
            responseMode: { type: "direct_post" },
        });
        return { session: res.body.session as string, authRequest, resolved };
    }

    /** Submit the vp_token and return the HTTP status and the session. */
    async function submit(
        started: Awaited<ReturnType<typeof start>>,
        vpToken: string,
    ) {
        const authorizationResponse =
            await client.createOpenid4vpAuthorizationResponse({
                authorizationRequestPayload: started.authRequest.params,
                authorizationResponsePayload: {
                    response: await encryptVpToken(
                        vpToken,
                        "credential",
                        started.resolved,
                    ),
                },
                ...callbacks,
            });
        const submitRes = await client.submitOpenid4vpAuthorizationResponse({
            authorizationResponsePayload:
                authorizationResponse.authorizationResponsePayload,
            authorizationRequestPayload: started.resolved
                .authorizationRequestPayload as Openid4vpAuthorizationRequest,
        });
        const session = await request(app.getHttpServer())
            .get(`/session/${started.session}`)
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);
        return { status: submitRes.response.status, session: session.body };
    }

    /**
     * Present an SD-JWT VC of `issuer` for the config, with a status list
     * signed by `statusListSigner`.
     */
    async function presentSdJwt(
        requestId: string,
        issuer: Signer,
        statusListSigner: Signer = issuer,
    ) {
        const statusListPath = `/status-list-${randomUUID()}`;
        const statusListUri = `${HOST}${statusListPath}`;
        nock(HOST)
            .get(statusListPath)
            .reply(200, await statusListJwt(statusListSigner, statusListUri), {
                "Content-Type": "application/statuslist+jwt",
            });
        const started = await start(requestId);
        const payload = started.resolved.authorizationRequestPayload;
        const vpToken = await preparePresentation(
            {
                iat: Math.floor(Date.now() / 1000),
                aud: payload.client_id as string,
                nonce: payload.nonce,
            },
            issuer.privateKey,
            [der(issuer)],
            {
                createEntry: async () => ({
                    status: { status_list: { idx: 3, uri: statusListUri } },
                }),
            } as unknown as StatusListService,
            "credential",
            undefined,
            undefined,
            { claims: { vct: VCT } },
        );
        return submit(started, vpToken);
    }

    /** Present an mdoc of `issuer` without status information. */
    async function presentMdoc(issuer: Signer) {
        const started = await start(configs.mdoc);
        const payload = started.resolved.authorizationRequestPayload;
        const encryptionKey = payload.client_metadata?.jwks?.keys?.[0] as
            | Record<string, string>
            | undefined;
        const vpToken = await prepareMdocPresentation(
            payload.nonce,
            issuer.privateKey,
            issuer.certificate.toString("pem"),
            payload.client_id!,
            payload.response_uri as string,
            payload.response_mode ?? "direct_post.jwt",
            encryptionKey
                ? new Uint8Array(
                      createHash("sha256")
                          .update(
                              JSON.stringify({
                                  crv: encryptionKey.crv,
                                  kty: encryptionKey.kty,
                                  x: encryptionKey.x,
                                  y: encryptionKey.y,
                              }),
                          )
                          .digest(),
                  )
                : undefined,
            undefined,
            ["given_name"],
            DOCTYPE,
        );
        return submit(started, vpToken);
    }

    // RP_WS_SM_TrustMechanisms_010a
    test("accepts a QEAA of a granted qualified service, with its status list signed under the same certificate", async () => {
        const { status, session } = await presentSdJwt(configs.lotl, qpA);

        expect(status).toBe(200);
        expect(session.status).toBe("completed");
    });

    test("accepts a QEAA through a national Trusted List referenced directly", async () => {
        const { status, session } = await presentSdJwt(configs.tl, qpA);

        expect(status).toBe(200);
        expect(session.status).toBe("completed");
    });

    // RP_WS_SM_TrustMechanisms_011a_UF
    test.each([
        ["not qualified", () => qpN],
        ["withdrawn", () => qpW],
    ])(
        "rejects an attestation of a QTSP whose service is %s",
        async (_, issuer) => {
            const { status, session } = await presentSdJwt(
                configs.lotl,
                issuer(),
            );

            expect(status).toBe(400);
            expect(session.status).toBe("failed");
        },
    );

    test("rejects a status list signed under the qualified service of another QTSP", async () => {
        const { status, session } = await presentSdJwt(configs.lotl, qpA, qpB);

        expect(status).toBe(400);
        expect(session.status).toBe("failed");
        expect(session.errorReason).toContain(
            "Status List JWT verification failed",
        );
    });

    test("rejects every QEAA when the list of trusted lists is not signed by its pinned certificate", async () => {
        const { status, session } = await presentSdJwt(configs.forged, qpA);

        expect(status).toBe(400);
        expect(session.status).toBe("failed");
    });

    // OIA_15 note: anchors keep their category.
    test("trusts a PID provider of a LoTE as such, but not as QTSP through its granted CA/QC service", async () => {
        const asPid = await presentSdJwt(configs.pid, pidProvider);
        expect(asPid.status).toBe(200);
        expect(asPid.session.status).toBe("completed");

        const asQeaa = await presentSdJwt(configs.lotl, pidProvider);
        expect(asQeaa.status).toBe(400);
        expect(asQeaa.session.status).toBe("failed");
    });

    test("does not accept a QTSP as PID provider, nor through a LoTE that lists it with the QEAA service type", async () => {
        const asPid = await presentSdJwt(configs.pid, qpA);
        expect(asPid.status).toBe(400);
        expect(asPid.session.status).toBe("failed");

        const throughLote = await presentSdJwt(configs.loteQeaa, qpA);
        expect(throughLote.status).toBe(400);
        expect(throughLote.session.status).toBe("failed");
    });

    test("names the list of trusted lists to the wallet when key identifiers do not cover its QTSPs", async () => {
        const { resolved } = await start(configs.lotl);

        // The test certificates carry no key identifiers.
        expect(
            resolved.authorizationRequestPayload.dcql_query?.credentials?.[0]
                ?.trusted_authorities,
        ).toEqual([{ type: "etsi_tl", values: [lotlUrl] }]);
    });

    // RP_WS_SM_TrustMechanisms_010b and _011b_UF
    test("accepts an mdoc QEAA of a granted qualified service and rejects one of a withdrawn service", async () => {
        const granted = await presentMdoc(qpA);
        expect(granted.session).toMatchObject({ status: "completed" });
        expect(granted.status).toBe(200);

        const withdrawn = await presentMdoc(qpW);
        expect(withdrawn.status).toBe(400);
        expect(withdrawn.session.status).toBe("failed");
    });
});
