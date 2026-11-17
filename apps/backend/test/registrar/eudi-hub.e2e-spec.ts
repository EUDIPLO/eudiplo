import { randomBytes, webcrypto } from "node:crypto";
import { join } from "node:path";
import { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import * as x509 from "@peculiar/x509";
import nock from "nock";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { AppModule } from "../../src/app.module.js";
import { Role } from "../../src/auth/roles/role.enum.js";
import { createAppValidationPipe } from "../../src/shared/common/zod/zod-schema.util.js";
import { PresentationConfig } from "../../src/verifier/presentations/entities/presentation-config.entity.js";
import { getTenantAdminToken, readConfig } from "../utils.js";

/** The default EUDI_HUB_API_URL. */
const hub = "https://api.eudi-hub.gov.de";
const base = "/org-management/v1";
const ORG = "01932c5a-9abc-7000-8000-000000000010";
const PORTAL_TOKEN = "eyJhbGciOiJSUzI1NiJ9.portal.signature";

const crypto = webcrypto as Crypto;
const algorithm = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };

/** Signs the key of a CSR with a CA of its own, as the EUDI Hub does; DER. */
async function issueFor(csrPem: string): Promise<ArrayBuffer> {
    const csr = new x509.Pkcs10CertificateRequest(csrPem);
    const ca = (await crypto.subtle.generateKey(algorithm, true, [
        "sign",
        "verify",
    ])) as CryptoKeyPair;
    const cert = await x509.X509CertificateGenerator.create(
        {
            serialNumber: "0b",
            subject: "CN=Relying party",
            issuer: "CN=EUDI Hub Access CA",
            notBefore: new Date(Date.now() - 60_000),
            notAfter: new Date(Date.now() + 3_600_000),
            signingAlgorithm: algorithm,
            publicKey: await csr.publicKey.export(crypto),
            signingKey: ca.privateKey,
        },
        crypto,
    );
    return cert.rawData;
}

function hubCertificate(id: string) {
    return {
        id,
        name: "EUDI Hub access",
        status: "valid",
        environment: "sandbox",
        createdAt: "2026-11-16T00:00:00Z",
        validFromDate: "2026-11-16T00:00:00Z",
        expirationDate: "2027-11-16T00:00:00Z",
        clientId: "X509_hash:abc",
    };
}

describe("Access certificate from the EUDI Hub (e2e)", () => {
    let app: INestApplication;
    let registrarToken: string;
    let keysOnlyToken: string;
    let configService: ConfigService;
    // The test database outlives a run, so each run gets its own tenant.
    const tenantId = `eudi-hub-e2e-${randomBytes(4).toString("hex")}`;

    const createKeyChain = async (usageType = "access") =>
        (
            await request(app.getHttpServer())
                .post("/key-chain")
                .set("Authorization", `Bearer ${registrarToken}`)
                .send({
                    usageType,
                    type: "standalone",
                    description: "EUDI Hub access",
                })
                .expect(201)
        ).body.id as string;

    const requestCertificate = (keyId: string, token = registrarToken) =>
        request(app.getHttpServer())
            .post("/eudi-hub/access-certificate")
            .set("Authorization", `Bearer ${token}`)
            .send({
                token: `Bearer ${PORTAL_TOKEN}`,
                organizationId: ORG,
                keyId,
                environment: "sandbox",
                supportUri: "https://support.example",
            });

    beforeAll(async () => {
        const moduleFixture: TestingModule = await Test.createTestingModule({
            imports: [AppModule],
        }).compile();
        app = moduleFixture.createNestApplication();
        app.useGlobalPipes(createAppValidationPipe());
        await app.init();

        configService = app.get(ConfigService);
        const clientId = configService.getOrThrow<string>("AUTH_CLIENT_ID");
        const clientSecret =
            configService.getOrThrow<string>("AUTH_CLIENT_SECRET");
        registrarToken = await getTenantAdminToken(
            app,
            clientId,
            clientSecret,
            tenantId,
            [Role.Registrar, Role.Keys, Role.Presentations, Role.Issuances],
        );
        keysOnlyToken = await getTenantAdminToken(
            app,
            clientId,
            clientSecret,
            `${tenantId}-keys`,
            [Role.Keys],
        );
    });

    afterEach(() => {
        nock.cleanAll();
    });

    afterAll(async () => {
        await app?.close();
    });

    test("lists the organizations with the pasted token", async () => {
        nock(hub)
            .matchHeader("authorization", `Bearer ${PORTAL_TOKEN}`)
            .get(`${base}/me`)
            .reply(200, { organizations: [{ id: ORG, name: "Org" }] });

        const res = await request(app.getHttpServer())
            .post("/eudi-hub/organizations")
            .set("Authorization", `Bearer ${registrarToken}`)
            .send({ token: PORTAL_TOKEN })
            .expect(200);

        expect(res.body).toEqual([{ id: ORG, name: "Org" }]);
    });

    test("stores the certificate the EUDI Hub issued for the key", async () => {
        const keyId = await createKeyChain();
        let der: ArrayBuffer | undefined;
        // The caller pasted "Bearer …"; the prefix is not sent twice.
        nock(hub)
            .matchHeader("authorization", `Bearer ${PORTAL_TOKEN}`)
            .post(`${base}/organizations/${ORG}/access-certificates`)
            .reply(201, async (req: Request) => {
                der = await issueFor((await req.json()).csr);
                return hubCertificate("hub-1");
            })
            .get(
                `${base}/organizations/${ORG}/access-certificates/hub-1/download`,
            )
            .reply(200, () => Buffer.from(der!), {
                "content-type": "application/pkix-cert",
            });

        const res = await requestCertificate(keyId).expect(201);

        expect(res.body).toMatchObject({
            id: "hub-1",
            certId: keyId,
            environment: "sandbox",
            clientId: "X509_hash:abc",
        });
        const stored = await request(app.getHttpServer())
            .get(`/key-chain/${keyId}`)
            .set("Authorization", `Bearer ${registrarToken}`)
            .expect(200);
        expect(stored.body.activeCertificate.issuer).toBe(
            "CN=EUDI Hub Access CA",
        );
        expect(stored.body.description).toBe("EUDI Hub access");
    });

    test("refuses a caller without the registrar:manage role", async () => {
        await request(app.getHttpServer())
            .post("/eudi-hub/organizations")
            .set("Authorization", `Bearer ${keysOnlyToken}`)
            .send({ token: PORTAL_TOKEN })
            .expect(403);
    });

    test("answers 404 for an unknown key chain", async () => {
        const response = await requestCertificate("does-not-exist");

        expect(response.status).toBe(404);
    });

    test("refuses a key chain that is not an access key chain", async () => {
        const keyId = await createKeyChain("attestation");

        await requestCertificate(keyId).expect(400);
    });

    test("refuses a token that could add a header line", async () => {
        await request(app.getHttpServer())
            .post("/eudi-hub/organizations")
            .set("Authorization", `Bearer ${registrarToken}`)
            .send({ token: "abc\r\nX-Evil: 1" })
            .expect(400);
    });

    test("reports a token the EUDI Hub refused as 400", async () => {
        const keyId = await createKeyChain();
        nock(hub)
            .post(`${base}/organizations/${ORG}/access-certificates`)
            .reply(401, { title: "Unauthorized" });

        const res = await requestCertificate(keyId).expect(400);

        expect(res.body.message).toContain("copy a fresh one");
    });

    test("reports a server error of the EUDI Hub as 502", async () => {
        const keyId = await createKeyChain();
        nock(hub)
            .post(`${base}/organizations/${ORG}/access-certificates`)
            .reply(503, { detail: "Upstream CA down" })
            .get(`${base}/organizations/${ORG}/access-certificates`)
            .query(true)
            .reply(200, { items: [], pageInfo: { pageSize: 0 } });

        const res = await requestCertificate(keyId).expect(502);

        expect(res.body.message).toContain("HTTP 503 (Upstream CA down)");
    });

    test("stores a certificate the EUDI Hub issued although it answered with a server error", async () => {
        const keyId = await createKeyChain();
        let der: ArrayBuffer | undefined;
        nock(hub)
            .post(`${base}/organizations/${ORG}/access-certificates`)
            .reply(503, async (req: Request) => {
                der = await issueFor((await req.json()).csr);
                return { detail: "Timeout" };
            })
            .get(`${base}/organizations/${ORG}/access-certificates`)
            .query({ environment: "sandbox", limit: "100" })
            .reply(200, {
                items: [hubCertificate("hub-2")],
                pageInfo: { pageSize: 1 },
            })
            .get(
                `${base}/organizations/${ORG}/access-certificates/hub-2/download`,
            )
            .reply(200, () => Buffer.from(der!), {
                "content-type": "application/pkix-cert",
            });

        const res = await requestCertificate(keyId).expect(201);

        expect(res.body.id).toBe("hub-2");
        const stored = await request(app.getHttpServer())
            .get(`/key-chain/${keyId}`)
            .set("Authorization", `Bearer ${registrarToken}`)
            .expect(200);
        expect(stored.body.activeCertificate.issuer).toBe(
            "CN=EUDI Hub Access CA",
        );
    });

    test("refuses and revokes a certificate the EUDI Hub issued for another key", async () => {
        const keyId = await createKeyChain();
        const otherKey = (await crypto.subtle.generateKey(algorithm, true, [
            "sign",
            "verify",
        ])) as CryptoKeyPair;
        const otherCsr = await x509.Pkcs10CertificateRequestGenerator.create(
            {
                name: "CN=Other",
                keys: otherKey,
                signingAlgorithm: algorithm,
            },
            crypto,
        );
        const der = await issueFor(otherCsr.toString("pem"));
        nock(hub)
            .post(`${base}/organizations/${ORG}/access-certificates`)
            .reply(201, hubCertificate("hub-1"))
            .get(
                `${base}/organizations/${ORG}/access-certificates/hub-1/download`,
            )
            .reply(200, Buffer.from(der), {
                "content-type": "application/pkix-cert",
            });
        const revoke = nock(hub)
            .post(
                `${base}/organizations/${ORG}/access-certificates/hub-1/revoke`,
                { revocationReason: "cessationOfOperation" },
            )
            .reply(200, hubCertificate("hub-1"));

        await requestCertificate(keyId).expect(400);

        expect(revoke.isDone()).toBe(true);
    });

    test("refuses a request the outbound URL policy blocks without contacting the EUDI Hub", async () => {
        const hubCalled = nock(hub).get(`${base}/me`).reply(200, {
            organizations: [],
        });
        configService.set("OUTBOUND_URL_ALLOWED_HOSTS", "registrar.example");
        try {
            const res = await request(app.getHttpServer())
                .post("/eudi-hub/organizations")
                .set("Authorization", `Bearer ${registrarToken}`)
                .send({ token: PORTAL_TOKEN })
                .expect(400);

            expect(res.body.message).toContain("api.eudi-hub.gov.de");
            expect(hubCalled.isDone()).toBe(false);
        } finally {
            configService.set("OUTBOUND_URL_ALLOWED_HOSTS", "");
        }
    });

    /** Answers a registration certificate the way the EUDI Hub builds it from a credential request. */
    function unsignedJwt(payload: Record<string, unknown>): string {
        const part = (value: unknown) =>
            Buffer.from(JSON.stringify(value)).toString("base64url");
        return `${part({ alg: "ES256", typ: "rc-wrp+jwt" })}.${part({
            exp: Math.floor(Date.now() / 1000) + 3600,
            ...payload,
        })}.c2ln`;
    }

    const certificateFields = {
        token: PORTAL_TOKEN,
        organizationId: ORG,
        environment: "sandbox",
        identifier: {
            type: "http://data.europa.eu/eudi/id/EUID",
            value: "DE/HRB123456B",
        },
        serviceDescription: [
            { lang: "de", content: "Altersprüfung" },
            { lang: "en", content: "Age check" },
        ],
        supportUri: "https://support.example",
        infoUri: "https://info.example",
    };

    test("stores a verifier registration certificate from the EUDI Hub in the presentation configuration", async () => {
        const id = `hub-age-${randomBytes(3).toString("hex")}`;
        // Stored directly, so the trust list it names need not exist. Trust
        // authorities do not go into the credential request.
        await app.get(getRepositoryToken(PresentationConfig)).save({
            id,
            tenantId,
            description: "Age check",
            dcql_query: {
                credentials: [
                    {
                        id: "pid",
                        format: "dc+sd-jwt",
                        meta: { vct_values: ["urn:eudi:pid:de:1"] },
                        claims: [{ path: ["age_over_18"] }],
                        trusted_authorities: [
                            {
                                type: "etsi_tl",
                                values: [{ trustListId: "pid-providers" }],
                            },
                        ],
                    },
                ],
            },
        });
        let jwt = "";
        let certificateBody: unknown;
        nock(hub)
            .get(`${base}/organizations/${ORG}/credential-requests`)
            .query(true)
            .reply(200, { items: [], pageInfo: { pageSize: 0 } })
            .post(`${base}/organizations/${ORG}/credential-requests`)
            .reply(201, async (req: Request) => {
                const body = await req.json();
                jwt = unsignedJwt({
                    credentials: body.credentials.map((credential: any) => ({
                        format: credential.format,
                        meta: { vct_values: [credential.type] },
                        claim: credential.claims,
                    })),
                });
                return { id: "cr-1", ...body };
            })
            .post(
                `${base}/organizations/${ORG}/registration-certificates`,
                (body) => {
                    certificateBody = body;
                    return true;
                },
            )
            .reply(201, {
                id: "rc-1",
                name: "Age check",
                status: "valid",
                environment: "sandbox",
            })
            .get(
                `${base}/organizations/${ORG}/registration-certificates/rc-1/download`,
            )
            .reply(200, () => jwt, { "content-type": "application/jwt" });

        const res = await request(app.getHttpServer())
            .post("/eudi-hub/registration-certificate/presentation")
            .set("Authorization", `Bearer ${registrarToken}`)
            .send({
                ...certificateFields,
                presentationConfigId: id,
                purpose: [
                    { lang: "de", content: "Altersprüfung" },
                    { lang: "en", content: "Age check" },
                ],
                privacyPolicy: "https://verifier.example/privacy",
            })
            .expect(201);

        expect(res.body).toMatchObject({
            id: "rc-1",
            credentialRequestId: "cr-1",
            reusedCredentialRequest: false,
        });
        const { token: _, organizationId: __, ...fields } = certificateFields;
        expect(certificateBody).toEqual({
            ...fields,
            name: "Age check",
            type: "credentialRequest",
            credentialRequestId: "cr-1",
        });
        const stored = await request(app.getHttpServer())
            .get(`/verifier/config/${id}`)
            .set("Authorization", `Bearer ${registrarToken}`)
            .expect(200);
        // The purpose and privacy policy are kept for renewing.
        expect(stored.body.registration_cert).toEqual({
            jwt,
            purpose: [
                { lang: "de", content: "Altersprüfung" },
                { lang: "en", content: "Age check" },
            ],
            privacy_policy: "https://verifier.example/privacy",
        });
    });

    test("refuses a verifier registration certificate without the presentation:manage role", async () => {
        const token = await getTenantAdminToken(
            app,
            app.get(ConfigService).getOrThrow<string>("AUTH_CLIENT_ID"),
            app.get(ConfigService).getOrThrow<string>("AUTH_CLIENT_SECRET"),
            `${tenantId}-registrar-only`,
            [Role.Registrar],
        );

        await request(app.getHttpServer())
            .post("/eudi-hub/registration-certificate/presentation")
            .set("Authorization", `Bearer ${token}`)
            .send({
                ...certificateFields,
                presentationConfigId: "any",
                purpose: certificateFields.serviceDescription,
                privacyPolicy: "https://verifier.example/privacy",
            })
            .expect(403);
    });

    test("stores an issuer registration certificate from the EUDI Hub", async () => {
        const keyChainId = (
            await request(app.getHttpServer())
                .post("/key-chain")
                .set("Authorization", `Bearer ${registrarToken}`)
                .send({ usageType: "attestation", type: "standalone" })
                .expect(201)
        ).body.id;
        const credentialConfig = readConfig<Record<string, unknown>>(
            join(
                __dirname,
                "../fixtures/haip/issuance/credentials/pid-no-key.json",
            ),
        );
        await request(app.getHttpServer())
            .post("/issuer/credentials")
            .set("Authorization", `Bearer ${registrarToken}`)
            .send({ ...credentialConfig, id: "hub-pid", keyChainId })
            .expect(201);
        const jwt = unsignedJwt({
            provides_attestations: [
                {
                    format: "dc+sd-jwt",
                    meta: { vct_values: ["urn:eudi:pid:de:1"] },
                },
            ],
        });
        nock(hub)
            .get(`${base}/organizations/${ORG}/credential-issuances`)
            .query(true)
            .reply(200, { items: [], pageInfo: { pageSize: 0 } })
            .post(`${base}/organizations/${ORG}/credential-issuances`, {
                name: "urn:eudi:pid:de:1",
                credential: { format: "dc+sd-jwt", type: "urn:eudi:pid:de:1" },
                environments: ["sandbox"],
            })
            .reply(201, { id: "ci-1" })
            .post(`${base}/organizations/${ORG}/registration-certificates`)
            .reply(201, {
                id: "rc-2",
                name: "Issuer registration certificate",
                status: "valid",
                environment: "sandbox",
            })
            .get(
                `${base}/organizations/${ORG}/registration-certificates/rc-2/download`,
            )
            .reply(200, jwt, { "content-type": "application/jwt" });

        const res = await request(app.getHttpServer())
            .post("/eudi-hub/registration-certificate/issuer")
            .set("Authorization", `Bearer ${registrarToken}`)
            .send(certificateFields)
            .expect(201);

        expect(res.body).toMatchObject({
            id: "rc-2",
            credentialIssuanceIds: ["ci-1"],
        });
        const stored = await request(app.getHttpServer())
            .get("/issuer/config")
            .set("Authorization", `Bearer ${registrarToken}`)
            .expect(200);
        expect(stored.body.registrationCertificate).toEqual({
            enabled: true,
            jwt,
            supportUri: certificateFields.supportUri,
        });
    });

    test("reads the organization's data from the EUDI Hub", async () => {
        nock(hub)
            .get(`${base}/organizations/${ORG}`)
            .reply(200, {
                id: ORG,
                name: "Example GmbH",
                serviceDescription: [],
                legalInformation: {
                    identifier: [
                        {
                            type: "http://data.europa.eu/eudi/id/EUID",
                            value: "DE/HRB1",
                        },
                    ],
                    privacyPolicyUris: ["https://example.com/privacy"],
                },
                contactInformation: {
                    supportUris: ["https://example.com/support"],
                    infoUris: ["https://example.com"],
                },
            })
            .get(`${base}/organizations/${ORG}`)
            .reply(401, { title: "Unauthorized" });
        const send = () =>
            request(app.getHttpServer())
                .post("/eudi-hub/organization-details")
                .set("Authorization", `Bearer ${registrarToken}`)
                .send({ token: PORTAL_TOKEN, organizationId: ORG });

        expect((await send().expect(200)).body).toMatchObject({
            identifiers: [
                {
                    type: "http://data.europa.eu/eudi/id/EUID",
                    value: "DE/HRB1",
                },
            ],
            privacyPolicyUris: ["https://example.com/privacy"],
            supportUris: ["https://example.com/support"],
        });
        expect((await send().expect(400)).body.message).toContain(
            "copy a fresh one",
        );
    });

    test("answers 409 for an unknown presentation configuration without calling the EUDI Hub", async () => {
        const hubCalled = nock(hub)
            .get(`${base}/organizations/${ORG}/credential-requests`)
            .query(true)
            .reply(200, { items: [] });

        await request(app.getHttpServer())
            .post("/eudi-hub/registration-certificate/presentation")
            .set("Authorization", `Bearer ${registrarToken}`)
            .send({
                ...certificateFields,
                presentationConfigId: "missing",
                purpose: certificateFields.serviceDescription,
                privacyPolicy: "https://verifier.example/privacy",
            })
            .expect(409);
        expect(hubCalled.isDone()).toBe(false);
    });

    test("refuses an issuer registration certificate without the issuance:manage role", async () => {
        const token = await getTenantAdminToken(
            app,
            configService.getOrThrow<string>("AUTH_CLIENT_ID"),
            configService.getOrThrow<string>("AUTH_CLIENT_SECRET"),
            `${tenantId}-registrar-issuer`,
            [Role.Registrar, Role.Presentations],
        );

        await request(app.getHttpServer())
            .post("/eudi-hub/registration-certificate/issuer")
            .set("Authorization", `Bearer ${token}`)
            .send(certificateFields)
            .expect(403);
    });
});
