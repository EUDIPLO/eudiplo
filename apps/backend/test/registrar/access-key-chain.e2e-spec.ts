import { randomBytes, webcrypto } from "node:crypto";
import { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import * as x509 from "@peculiar/x509";
import nock from "nock";
import request from "supertest";
import {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    test,
} from "vitest";
import { AppModule } from "../../src/app.module.js";
import { Role } from "../../src/auth/roles/role.enum.js";
import { KeyChainService } from "../../src/crypto/key/key-chain.service.js";
import { KeyUsageType } from "../../src/crypto/key/types/key-usage-type.js";
import { createAppValidationPipe } from "../../src/shared/common/zod/zod-schema.util.js";
import { getTenantAdminToken } from "../utils.js";

const idp = "https://auth.registrar.example";
const realm = "/realms/registrar";
const registrar = "https://registrar.example";

const crypto = webcrypto as Crypto;
const algorithm = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };

/** Signs the key of a CSR with a CA of its own, as the registrar does. */
async function issueFor(csrPem: string): Promise<string> {
    const csr = new x509.Pkcs10CertificateRequest(csrPem);
    const ca = (await crypto.subtle.generateKey(algorithm, true, [
        "sign",
        "verify",
    ])) as CryptoKeyPair;
    const cert = await x509.X509CertificateGenerator.create(
        {
            serialNumber: "0a",
            subject: "CN=Relying party",
            issuer: "CN=Registrar CA",
            notBefore: new Date(Date.now() - 60_000),
            notAfter: new Date(Date.now() + 3_600_000),
            signingAlgorithm: algorithm,
            publicKey: await csr.publicKey.export(crypto),
            signingKey: ca.privateKey,
        },
        crypto,
    );
    return cert.toString("pem");
}

/** OIDC discovery and the password grant of the registrar account. */
function oidcProvider() {
    nock(idp)
        .persist()
        .get(`${realm}/.well-known/openid-configuration`)
        .reply(200, {
            issuer: `${idp}${realm}`,
            token_endpoint: `${idp}${realm}/protocol/openid-connect/token`,
        })
        .post(`${realm}/protocol/openid-connect/token`)
        .reply(200, {
            access_token: "token",
            token_type: "Bearer",
            expires_in: 300,
        });
}

describe("Access key chain enrolled at the registrar (e2e)", () => {
    let app: INestApplication;
    let authToken: string;
    // The test database outlives a run, so each run gets its own tenant.
    const tenantId = `registrar-access-key-chain-e2e-${randomBytes(4).toString("hex")}`;
    /** Self-signed access key chain created before any enrollment. */
    let selfSignedId: string;
    /** The key chains enrolled at the registrar. */
    const enrolledIds: string[] = [];

    const accessKeyChains = async () => {
        const res = await request(app.getHttpServer())
            .get("/key-chain")
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);
        return (res.body as { id: string; usageType: string }[]).filter(
            (keyChain) => keyChain.usageType === "access",
        );
    };

    /** PEM of the active certificate of a key chain of the tenant. */
    const storedCertificate = async (id: string) => {
        const res = await request(app.getHttpServer())
            .get(`/key-chain/${id}`)
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);
        return (res.body.activeCertificate.pem as string).trim();
    };

    const createAccessKeyChain = () =>
        request(app.getHttpServer())
            .post("/registrar/access-key-chain")
            .set("Authorization", `Bearer ${authToken}`)
            .send({ description: "Registrar access" });

    beforeAll(async () => {
        const moduleFixture: TestingModule = await Test.createTestingModule({
            imports: [AppModule],
        }).compile();
        app = moduleFixture.createNestApplication();
        app.useGlobalPipes(createAppValidationPipe());
        await app.init();

        const configService = app.get(ConfigService);
        authToken = await getTenantAdminToken(
            app,
            configService.getOrThrow<string>("AUTH_CLIENT_ID"),
            configService.getOrThrow<string>("AUTH_CLIENT_SECRET"),
            tenantId,
            [Role.Registrar, Role.Keys],
        );
        selfSignedId = (
            await request(app.getHttpServer())
                .post("/key-chain")
                .set("Authorization", `Bearer ${authToken}`)
                .send({ usageType: "access", type: "standalone" })
                .expect(201)
        ).body.id;

        oidcProvider();
        await request(app.getHttpServer())
            .post("/registrar/config")
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                registrarUrl: registrar,
                oidcUrl: `${idp}${realm}`,
                clientId: "registrar-client",
                username: "registrar-user",
                password: "registrar-password",
            })
            .expect(201);
    });

    beforeEach(() => {
        oidcProvider();
        nock(registrar)
            .persist()
            .get("/relying-parties")
            .reply(200, [{ id: "rp-1" }]);
    });

    afterEach(() => {
        nock.cleanAll();
    });

    afterAll(async () => {
        await app?.close();
    });

    test("keeps no access key chain when the registrar refuses the certificate", async () => {
        const before = await accessKeyChains();
        nock(registrar)
            .post("/access-certificates")
            .reply(400, { message: "CSR rejected" })
            .get("/access-certificates")
            .query({ rp: "rp-1" })
            .reply(200, []);

        await createAccessKeyChain().expect(400);

        expect(await accessKeyChains()).toEqual(before);
    });

    test("stores the certificate the registrar issued", async () => {
        let crt = "";
        nock(registrar)
            .post("/access-certificates")
            .reply(201, async (req: Request) => {
                crt = await issueFor((await req.json()).csr);
                return { id: "ac-1", crt };
            });

        const res = await createAccessKeyChain().expect(201);

        expect(res.body).toEqual({
            id: "ac-1",
            certId: expect.any(String),
            crt,
        });
        expect(await storedCertificate(res.body.certId)).toBe(crt.trim());
        enrolledIds.push(res.body.certId);
    });

    test("refuses and revokes a certificate the registrar issued for another key", async () => {
        const before = await accessKeyChains();
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
        const crt = await issueFor(otherCsr.toString("pem"));
        nock(registrar)
            .post("/access-certificates")
            .reply(201, { id: "ac-foreign", crt });
        const revoked = nock(registrar)
            .delete("/access-certificates/ac-foreign")
            .reply(204);

        const res = await createAccessKeyChain().expect(400);

        expect(res.body.message).toContain("not issued for the active key");
        expect(revoked.isDone()).toBe(true);
        expect(await accessKeyChains()).toEqual(before);
    });

    test("stores the certificate the registrar lists for the key when its response is lost", async () => {
        let crt = "";
        nock(registrar)
            .post("/access-certificates")
            .reply(502, async (req: Request) => {
                crt = await issueFor((await req.json()).csr);
                return "Bad Gateway";
            })
            .get("/access-certificates")
            .query({ rp: "rp-1" })
            .reply(200, () => [
                {
                    id: "ac-lost",
                    relyingPartyId: "rp-1",
                    certificate: crt,
                    issuanceMethod: "csr",
                    profile: "generic-wrpac",
                    revoked: null,
                    createdAt: new Date().toISOString(),
                },
            ]);

        const res = await createAccessKeyChain().expect(201);

        expect(res.body).toMatchObject({ id: "ac-lost", crt });
        expect(await storedCertificate(res.body.certId)).toBe(crt.trim());
        enrolledIds.push(res.body.certId);
    });

    // Runs against the database, unlike the unit tests of the rule.
    test("makes an enrolled key chain the default over an older self-signed one", async () => {
        nock(registrar)
            .post("/access-certificates")
            .reply(201, async (req: Request) => ({
                id: "ac-default",
                crt: await issueFor((await req.json()).csr),
            }));
        const enrolled = (await createAccessKeyChain().expect(201)).body.certId;
        enrolledIds.push(enrolled);

        const found = await app
            .get(KeyChainService)
            .findByUsageType(tenantId, KeyUsageType.Access);

        // Other tests of this file may have enrolled key chains in the same
        // second; SQLite stores createdAt in seconds, so the id decides then.
        expect(enrolledIds).toContain(found.id);
        expect(found.id).not.toBe(selfSignedId);
        expect(found.activeJwk).toBeDefined();
    });

    test("needs registrar:manage, not keys:manage, and a registrar configuration", async () => {
        const configService = app.get(ConfigService);
        const keysOnly = await getTenantAdminToken(
            app,
            configService.getOrThrow<string>("AUTH_CLIENT_ID"),
            configService.getOrThrow<string>("AUTH_CLIENT_SECRET"),
            `${tenantId}-keys`,
            [Role.Keys],
        );
        // tenant:admin, which every tenant admin token has, may not enroll either.
        const keysOnlyRes = await request(app.getHttpServer())
            .post("/registrar/access-key-chain")
            .set("Authorization", `Bearer ${keysOnly}`)
            .send({});
        expect(keysOnlyRes.status).toBe(403);

        const registrarOnly = await getTenantAdminToken(
            app,
            configService.getOrThrow<string>("AUTH_CLIENT_ID"),
            configService.getOrThrow<string>("AUTH_CLIENT_SECRET"),
            `${tenantId}-unconfigured`,
            [Role.Registrar],
        );
        const registrarOnlyRes = await request(app.getHttpServer())
            .post("/registrar/access-key-chain")
            .set("Authorization", `Bearer ${registrarOnly}`)
            .send({});
        expect(registrarOnlyRes.status).toBe(404);
    });

    test("creates no key chain without a registrar relying party answer", async () => {
        nock.cleanAll();
        oidcProvider();
        nock(registrar).get("/relying-parties").reply(500);
        const before = await accessKeyChains();

        await createAccessKeyChain().expect(400);

        expect(await accessKeyChains()).toEqual(before);
    });
});
