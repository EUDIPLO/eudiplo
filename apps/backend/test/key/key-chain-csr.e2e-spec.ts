import { webcrypto } from "node:crypto";
import { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import * as x509 from "@peculiar/x509";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AppModule } from "../../src/app.module.js";
import { KeyChainType } from "../../src/crypto/key/dto/key-chain-create.dto.js";
import { KeyUsageType } from "../../src/crypto/key/types/key-usage-type.js";
import { createAppValidationPipe } from "../../src/shared/common/zod/zod-schema.util.js";
import { getToken } from "../utils.js";

const EC = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGNING = { name: "ECDSA", hash: "SHA-256" } as const;

/** A CA outside EUDIPLO that issues certificates for CSRs. */
async function createExternalCa() {
    const keys = await webcrypto.subtle.generateKey(EC, true, [
        "sign",
        "verify",
    ]);
    const certificate = await x509.X509CertificateGenerator.createSelfSigned({
        name: "CN=External Test CA",
        keys,
        signingAlgorithm: SIGNING,
        notBefore: new Date(Date.now() - 60_000),
        notAfter: new Date(Date.now() + 86_400_000),
        extensions: [new x509.BasicConstraintsExtension(true, undefined, true)],
    });
    return {
        certificate,
        /** Issues a certificate for the public key and subject of the CSR. */
        issue: async (csr: x509.Pkcs10CertificateRequest) =>
            x509.X509CertificateGenerator.create({
                subject: csr.subject,
                issuer: certificate.subject,
                publicKey: csr.publicKey,
                signingKey: keys.privateKey,
                signingAlgorithm: SIGNING,
                notBefore: new Date(Date.now() - 60_000),
                notAfter: new Date(Date.now() + 86_400_000),
            }),
    };
}

describe("Key Chain — certificate signing request (e2e)", () => {
    let app: INestApplication;
    let authToken: string;

    beforeAll(async () => {
        const moduleFixture: TestingModule = await Test.createTestingModule({
            imports: [AppModule],
        }).compile();

        app = moduleFixture.createNestApplication();
        app.useGlobalPipes(createAppValidationPipe());
        await app.init();

        const configService = app.get(ConfigService);
        authToken = await getToken(
            app,
            configService.getOrThrow<string>("AUTH_CLIENT_ID"),
            configService.getOrThrow<string>("AUTH_CLIENT_SECRET"),
        );
    });

    afterAll(async () => {
        await app?.close();
    });

    async function createAccessKeyChain(): Promise<string> {
        const res = await request(app.getHttpServer())
            .post("/key-chain")
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                usageType: KeyUsageType.Access,
                type: KeyChainType.Standalone,
                description: "CSR test key",
            })
            .expect(201);
        return res.body.id;
    }

    async function getCsr(
        keyId: string,
        subject?: string,
    ): Promise<x509.Pkcs10CertificateRequest> {
        const res = await request(app.getHttpServer())
            .get(`/key-chain/${keyId}/csr`)
            .query(subject ? { subject } : {})
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);
        expect(res.body.csr).toContain("-----BEGIN CERTIFICATE REQUEST-----");
        return new x509.Pkcs10CertificateRequest(res.body.csr);
    }

    async function getKeyChain(keyId: string) {
        const res = await request(app.getHttpServer())
            .get(`/key-chain/${keyId}`)
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);
        return res.body;
    }

    test("the CSR holds the active key, signed by it, with the requested subject", async () => {
        const keyId = await createAccessKeyChain();
        const subject = "C=DE, O=Example Org, CN=Example Verifier";

        const csr = await getCsr(keyId, subject);

        expect(await csr.verify()).toBe(true);
        expect(csr.subject).toBe(subject);
        // The self-signed certificate of a new key chain holds the active key.
        const { activeCertificate } = await getKeyChain(keyId);
        const active = new x509.X509Certificate(activeCertificate.pem);
        expect(Buffer.from(csr.publicKey.rawData)).toEqual(
            Buffer.from(active.publicKey.rawData),
        );
    });

    test("the subject defaults to the key chain id", async () => {
        const keyId = await createAccessKeyChain();

        const csr = await getCsr(keyId);

        expect(csr.subject).toBe(`CN=${keyId}`);
    });

    test.each(["not a distinguished name", "CN=", `CN=${"a".repeat(1025)}`])(
        "refuses the subject %j",
        async (subject) => {
            const keyId = await createAccessKeyChain();

            await request(app.getHttpServer())
                .get(`/key-chain/${keyId}/csr`)
                .query({ subject })
                .set("Authorization", `Bearer ${authToken}`)
                .expect(400);
        },
    );

    test("refuses a subject given twice", async () => {
        const keyId = await createAccessKeyChain();

        await request(app.getHttpServer())
            .get(`/key-chain/${keyId}/csr?subject=CN%3Da&subject=CN%3Db`)
            .set("Authorization", `Bearer ${authToken}`)
            .expect(400);
    });

    test("answers 404 for an unknown key chain", async () => {
        await request(app.getHttpServer())
            .get("/key-chain/does-not-exist/csr")
            .set("Authorization", `Bearer ${authToken}`)
            .expect(404);
    });

    test("stores the certificate an external CA issued for the CSR", async () => {
        const keyId = await createAccessKeyChain();
        const ca = await createExternalCa();
        const issued = await ca.issue(
            await getCsr(keyId, "C=DE, O=Example Org, CN=Example Verifier"),
        );

        await request(app.getHttpServer())
            .put(`/key-chain/${keyId}`)
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                activeCertificate: `${issued.toString("pem")}\n${ca.certificate.toString("pem")}`,
            })
            .expect(204);

        const { activeCertificate } = await getKeyChain(keyId);
        expect(activeCertificate.issuer).toBe("CN=External Test CA");
        expect(activeCertificate.subject).toBe(
            "C=DE, O=Example Org, CN=Example Verifier",
        );
    });

    test("refuses a certificate issued for another key and keeps the current one", async () => {
        const keyId = await createAccessKeyChain();
        const otherKeyId = await createAccessKeyChain();
        const ca = await createExternalCa();
        const issuedForOther = await ca.issue(await getCsr(otherKeyId));
        const before = (await getKeyChain(keyId)).activeCertificate.pem;

        await request(app.getHttpServer())
            .put(`/key-chain/${keyId}`)
            .set("Authorization", `Bearer ${authToken}`)
            .send({ activeCertificate: issuedForOther.toString("pem") })
            .expect(400);

        expect((await getKeyChain(keyId)).activeCertificate.pem).toBe(before);
    });

    test("refuses an activeCertificate without a certificate", async () => {
        const keyId = await createAccessKeyChain();

        await request(app.getHttpServer())
            .put(`/key-chain/${keyId}`)
            .set("Authorization", `Bearer ${authToken}`)
            .send({ activeCertificate: "not a certificate" })
            .expect(400);
    });
});
