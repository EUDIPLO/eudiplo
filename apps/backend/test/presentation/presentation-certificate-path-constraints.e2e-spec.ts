import "reflect-metadata";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { INestApplication } from "@nestjs/common";
import {
    Openid4vpAuthorizationRequest,
    Openid4vpClient,
} from "@openid4vc/openid4vp";
import * as x509 from "@peculiar/x509";
import nock from "nock";
import request from "supertest";
import { App } from "supertest/types";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { StatusListService } from "../../src/issuer/status-list/status-list.service.js";
import { ResponseType } from "../../src/verifier/oid4vp/dto/presentation-request.dto.js";
import { PresentationConfigCreateDto } from "../../src/verifier/presentations/dto/presentation-config-create.dto.js";
import {
    createMockTrustListJwt,
    generateSelfSignedCertificate,
} from "../issuance/attestation-trust-helpers.js";
import { currentPeriod } from "../trust/attestation-certificate-periods.fixture.js";
import {
    chainCa,
    type IssuedCertificate,
} from "../trust/certificate-chain.fixture.js";
import {
    callbacks,
    createPresentationRequest,
    createTestFetch,
    encryptVpToken,
    prepareMdocPresentation,
    preparePresentation,
    readConfig,
    setupPresentationTestApp,
} from "../utils.js";

const algorithm = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };

/** A certificate below `issuer` with `extensions`, and its keys. */
async function issuedBy(
    issuer: IssuedCertificate,
    subject: string,
    extensions: x509.Extension[],
): Promise<IssuedCertificate> {
    const keys = (await crypto.subtle.generateKey(algorithm, true, [
        "sign",
        "verify",
    ])) as CryptoKeyPair;
    const cert = await x509.X509CertificateGenerator.create(
        {
            serialNumber: randomUUID().replaceAll("-", "").slice(0, 16),
            subject,
            issuer: issuer.cert.subject,
            ...currentPeriod(),
            publicKey: keys.publicKey,
            signingKey: issuer.keys.privateKey,
            signingAlgorithm: algorithm,
            extensions,
        },
        globalThis.crypto,
    );
    return { cert, keys };
}

const signerExtensions = (extra: x509.Extension[] = []) => [
    new x509.BasicConstraintsExtension(false, undefined, true),
    new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
    ...extra,
];

const caExtensions = (pathLength?: number) => [
    new x509.BasicConstraintsExtension(true, pathLength, true),
    new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
        true,
    ),
];

type Format = "dc+sd-jwt" | "mso_mdoc";

/** SHA-256 of the verifier's EC encryption key, for the mDOC session transcript. */
function jwkThumbprint(jwks?: {
    keys?: Array<Record<string, string>>;
}): Uint8Array | undefined {
    const key = jwks?.keys?.find((k) => k.use === "enc") ?? jwks?.keys?.[0];
    if (key?.kty !== "EC") return undefined;
    return new Uint8Array(
        createHash("sha256")
            .update(
                JSON.stringify({
                    crv: key.crv,
                    kty: key.kty,
                    x: key.x,
                    y: key.y,
                }),
            )
            .digest(),
    );
}

const b64 = ({ cert }: IssuedCertificate) =>
    Buffer.from(cert.rawData).toString("base64");

/**
 * RFC 5280 path constraints of issuer chains (issue #1616, the RP
 * conformance suite's RP_WS_SM_IssuerIntegrity_034*_UF and _037*_UF): an
 * external trust list lists a CA as EAA issuer; the `x5c` of an SD-JWT VC or
 * the `x5chain` of an mDOC leads to it.
 */
describe("Presentation - certificate path constraints of the issuer chain", () => {
    let app: INestApplication<App>;
    let authToken: string;
    let host: string;
    let client: Openid4vpClient;
    let anchor: IssuedCertificate;
    const run = randomUUID();
    const requestIds = {
        [`path-constraints-sd-jwt-${run}`]: "haip/presentation/pid.json",
        [`path-constraints-mdoc-${run}`]:
            "haip/presentation/pid-mdoc-no-hook.json",
    };
    const [sdJwtRequestId, mdocRequestId] = Object.keys(requestIds);

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

        anchor = await chainCa("C=DE, CN=CA-PP-I");
        const listSigner = await generateSelfSignedCertificate();
        const trustListPath = `/trust-list-${randomUUID()}`;
        nock("http://localhost:8787")
            .persist()
            .get(trustListPath)
            .reply(
                200,
                await createMockTrustListJwt(listSigner, anchor.cert, {
                    serviceTypeIdentifier:
                        "http://uri.etsi.org/19602/SvcType/EAA/Issuance",
                }),
                { "Content-Type": "application/jwt" },
            );

        for (const [requestId, fixture] of Object.entries(requestIds)) {
            const config = readConfig<PresentationConfigCreateDto>(
                join(resolve(__dirname, "../fixtures"), fixture),
            );
            config.id = requestId;
            config.dcql_query.credentials[0].trusted_authorities = [
                {
                    type: "etsi_tl",
                    values: [
                        {
                            url: `http://localhost:8787${trustListPath}`,
                            verifierX509Der:
                                listSigner.certificate.toString("base64"),
                        },
                    ],
                },
            ] as never;
            delete (config as { webhookEndpointId?: string }).webhookEndpointId;
            await request(app.getHttpServer())
                .post("/verifier/config")
                .trustLocalhost()
                .set("Authorization", `Bearer ${authToken}`)
                .send(config)
                .expect(201);
        }
    });

    afterEach(() => {
        nock.abortPendingRequests();
    });

    afterAll(async () => {
        nock.cleanAll();
        await app?.close();
    });

    /**
     * Present a credential signed by `signer` with `chain` (signing
     * certificate first) as `x5c` or `x5chain`; the HTTP status and the
     * session.
     */
    async function present(
        format: Format,
        signer: IssuedCertificate,
        chain: IssuedCertificate[],
    ) {
        const res = await createPresentationRequest(app, authToken, {
            response_type: ResponseType.URI,
            requestId: format === "dc+sd-jwt" ? sdJwtRequestId : mdocRequestId,
        });
        const authRequest = client.parseOpenid4vpAuthorizationRequest({
            authorizationRequest: res.body.uri,
        });
        const resolved = await client.resolveOpenid4vpAuthorizationRequest({
            authorizationRequestPayload: authRequest.params,
            responseMode: { type: "direct_post" },
        });
        const payload = resolved.authorizationRequestPayload;
        const vpToken =
            format === "dc+sd-jwt"
                ? await preparePresentation(
                      {
                          iat: Math.floor(Date.now() / 1000),
                          aud: payload.client_id as string,
                          nonce: payload.nonce,
                      },
                      signer.keys.privateKey,
                      chain.map(b64),
                      {} as unknown as StatusListService,
                      "pid",
                      undefined,
                      undefined,
                      { withStatus: false },
                  )
                : await prepareMdocPresentation(
                      payload.nonce,
                      signer.keys.privateKey,
                      chain.map(({ cert }) => cert.toString("pem")),
                      payload.client_id!,
                      payload.response_uri as string,
                      payload.response_mode ?? "direct_post.jwt",
                      jwkThumbprint(payload.client_metadata?.jwks),
                      undefined,
                      ["given_name"],
                  );
        const authorizationResponse =
            await client.createOpenid4vpAuthorizationResponse({
                authorizationRequestPayload: authRequest.params,
                authorizationResponsePayload: {
                    response: await encryptVpToken(
                        vpToken,
                        format === "dc+sd-jwt" ? "pid" : "pid-mdoc",
                        resolved,
                    ),
                },
                ...callbacks,
            });
        const submitRes = await client.submitOpenid4vpAuthorizationResponse({
            authorizationResponsePayload:
                authorizationResponse.authorizationResponsePayload,
            authorizationRequestPayload:
                payload as Openid4vpAuthorizationRequest,
        });
        const session = await request(app.getHttpServer())
            .get(`/session/${res.body.session}`)
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);
        return { status: submitRes.response.status, session: session.body };
    }

    describe.each<Format>(["dc+sd-jwt", "mso_mdoc"])("%s", (format) => {
        test("accepts a signer under an intermediate CA of the listed CA", async () => {
            const intermediate = await issuedBy(
                anchor,
                "C=DE, CN=PP-I intermediate",
                caExtensions(0),
            );
            const signer = await issuedBy(
                intermediate,
                "C=DE, CN=PP-I signer",
                signerExtensions(),
            );

            const { status, session } = await present(format, signer, [
                signer,
                intermediate,
            ]);

            expect(status).toBe(200);
            expect(session.status).toBe("completed");
        });

        // RP_WS_SM_IssuerIntegrity_034a_UF (SD-JWT VC), _034b_UF (mDOC)
        test("rejects a signer issued by a certificate without cA", async () => {
            const notCa = await issuedBy(
                anchor,
                "C=DE, CN=PP-I certificate without cA",
                [
                    new x509.BasicConstraintsExtension(false, undefined, true),
                    new x509.KeyUsagesExtension(
                        x509.KeyUsageFlags.keyCertSign |
                            x509.KeyUsageFlags.cRLSign,
                        true,
                    ),
                ],
            );
            const signer = await issuedBy(
                notCa,
                "C=DE, CN=PP-I under a certificate without cA signer",
                signerExtensions(),
            );

            const { status, session } = await present(format, signer, [
                signer,
                notCa,
            ]);

            expect(status).toBe(400);
            expect(session.status).toBe("failed");
            expect(session.failureCode).toBe("no_trust_chain_to_root");
            expect(session.credentials ?? []).toEqual([]);
        });

        // RP_WS_SM_IssuerIntegrity_037a_UF (SD-JWT VC), _037b_UF (mDOC)
        test("rejects a signer with an unknown critical extension", async () => {
            const signer = await issuedBy(
                anchor,
                "C=DE, CN=PP-A critical extension signer",
                signerExtensions([
                    new x509.Extension(
                        "1.3.6.1.4.1.55555.1.1",
                        true,
                        new Uint8Array([0x05, 0x00]),
                    ),
                ]),
            );

            const { status, session } = await present(format, signer, [signer]);

            expect(status).toBe(400);
            expect(session.status).toBe("failed");
            expect(session.failureCode).toBe("no_trust_chain_to_root");
            expect(session.credentials ?? []).toEqual([]);
        });
    });
});
