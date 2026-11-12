/**
 * Shared test helpers for wallet-provider trust-list and key-attestation E2E tests.
 * Used by issuance-preauth.e2e-spec.ts, issuance-deferred.e2e-spec.ts, and
 * wallet-attestation.e2e-spec.ts to avoid copy-paste drift.
 */

import type { INestApplication } from "@nestjs/common";
import { X509Certificate, X509CertificateGenerator } from "@peculiar/x509";
import { decodeJwt, decodeProtectedHeader, importPKCS8, SignJWT } from "jose";
import nock from "nock";
import request from "supertest";
import type { App } from "supertest/types";
import type { ValidityPeriod } from "../../src/shared/utils/certificate-validity.util.js";

/** Configure an authenticated provider list for a test, restoring the prior config afterwards. */
export async function configureTrustedAttestationProvider(
    app: INestApplication<App>,
    authToken: string,
) {
    const provider = await generateSelfSignedCertificate();
    const listSigner = await generateSelfSignedCertificate();
    const path = `/key-attestation-${crypto.randomUUID()}`;
    const current = await request(app.getHttpServer())
        .get("/issuer/config")
        .trustLocalhost()
        .set("Authorization", `Bearer ${authToken}`)
        .expect(200);
    await request(app.getHttpServer())
        .post("/issuer/config")
        .trustLocalhost()
        .set("Authorization", `Bearer ${authToken}`)
        .send({
            ...current.body,
            walletProviderTrustLists: [
                {
                    url: `http://localhost:8787${path}`,
                    verifierX509Der: listSigner.certificate.toString("base64"),
                },
            ],
        })
        .expect(201);
    nock("http://localhost:8787")
        .persist()
        .get(path)
        .reply(
            200,
            await createMockTrustListJwt(listSigner, provider.certificate),
            { "Content-Type": "application/jwt" },
        );
    return {
        provider,
        restore: () =>
            request(app.getHttpServer())
                .post("/issuer/config")
                .trustLocalhost()
                .set("Authorization", `Bearer ${authToken}`)
                .send(current.body)
                .expect(201),
    };
}

/** A self-signed wallet provider certificate, valid for a year from now unless `period` says otherwise. */
export async function generateSelfSignedCertificate(
    period: ValidityPeriod = {
        notBefore: new Date(),
        notAfter: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    },
): Promise<{
    certificate: X509Certificate;
    privateKey: CryptoKey;
    publicKey: CryptoKey;
}> {
    const keyPair = await globalThis.crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["sign", "verify"],
    );

    // Pass webcrypto instead of setting the global provider, which the
    // backend replaced with its KMS provider for key chain certificates.
    const cert = await X509CertificateGenerator.createSelfSigned(
        {
            serialNumber: "01",
            name: "CN=Test Wallet Provider",
            ...period,
            signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
            keys: keyPair,
        },
        globalThis.crypto,
    );

    return {
        certificate: cert,
        privateKey: keyPair.privateKey,
        publicKey: keyPair.publicKey,
    };
}

export async function createMockTrustListJwt(
    signingCert: { certificate: X509Certificate; privateKey: CryptoKey },
    walletProviderCert: X509Certificate,
    serviceTypeIdentifier = "http://uri.etsi.org/19602/SvcType/WalletSolution",
    sequenceNumber = 1,
): Promise<string> {
    const privateKeyArrayBuffer = await globalThis.crypto.subtle.exportKey(
        "pkcs8",
        signingCert.privateKey,
    );
    const privateKeyPem =
        "-----BEGIN PRIVATE KEY-----\n" +
        Buffer.from(privateKeyArrayBuffer).toString("base64") +
        "\n-----END PRIVATE KEY-----";
    const signingKey = await importPKCS8(privateKeyPem, "ES256");

    const x5c = signingCert.certificate.toString("base64");
    const walletCertBase64 = walletProviderCert.toString("base64");

    const lotePayload = {
        LoTE: {
            ListAndSchemeInformation: {
                LoTEVersionIdentifier: 1,
                LoTESequenceNumber: sequenceNumber,
                LoTEType:
                    "http://uri.etsi.org/19602/LoTEType/EUEAAProvidersList",
                StatusDeterminationApproach:
                    "http://uri.etsi.org/19602/EUEAAProvidersList/StatusDetn/EU",
                SchemeTerritory: "EU",
                NextUpdate: new Date(
                    Date.now() + 365 * 24 * 60 * 60 * 1000,
                ).toISOString(),
                ListIssueDateTime: new Date().toISOString(),
                SchemeOperatorName: [{ lang: "en", value: "Test Operator" }],
            },
            TrustedEntitiesList: [
                {
                    TrustedEntityInformation: {
                        TEName: [{ lang: "en", value: "Test Wallet Provider" }],
                    },
                    TrustedEntityServices: [
                        {
                            ServiceInformation: {
                                ServiceTypeIdentifier: serviceTypeIdentifier,
                                ServiceName: [
                                    {
                                        lang: "en",
                                        value: "Wallet Provider Service",
                                    },
                                ],
                                ServiceDigitalIdentity: {
                                    X509Certificates: [
                                        { val: walletCertBase64 },
                                    ],
                                },
                            },
                        },
                    ],
                },
            ],
        },
    };

    return new SignJWT(lotePayload)
        .setProtectedHeader({ alg: "ES256", typ: "JWT", x5c: [x5c] })
        .setIssuedAt()
        .setExpirationTime("1y")
        .sign(signingKey);
}

export async function addX5cHeaderToKeyAttestationJwt(
    keyAttestationJwt: string,
    signerPrivateKey: CryptoKey,
    signerCertificate: X509Certificate,
): Promise<string> {
    const privateKeyArrayBuffer = await globalThis.crypto.subtle.exportKey(
        "pkcs8",
        signerPrivateKey,
    );
    const privateKeyPem =
        "-----BEGIN PRIVATE KEY-----\n" +
        Buffer.from(privateKeyArrayBuffer).toString("base64") +
        "\n-----END PRIVATE KEY-----";
    const signingKey = await importPKCS8(privateKeyPem, "ES256");

    const header = decodeProtectedHeader(keyAttestationJwt);
    const payload = decodeJwt(keyAttestationJwt);

    return new SignJWT(payload)
        .setProtectedHeader({
            ...header,
            x5c: [signerCertificate.toString("base64")],
        })
        .sign(signingKey);
}
