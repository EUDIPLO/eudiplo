import { webcrypto } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as x509 from "@peculiar/x509";
import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { OutboundUrlPolicyService } from "../../../webhook/outbound-url-policy.service.js";
import { CrlValidationService } from "./crl-validation.service.js";

const crypto = webcrypto as Crypto;
const algorithm = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
const caName = "CN=issuer.example";

describe("CrlValidationService", () => {
    let server: Server;
    let port: number;
    /** CRL served per request path; unknown paths answer 404. */
    let crls: Record<string, ArrayBuffer>;
    let requests: string[];
    let caKeys: CryptoKeyPair;
    let caPem: string;

    const generateKeys = () =>
        crypto.subtle.generateKey(algorithm, true, [
            "sign",
            "verify",
        ]) as Promise<CryptoKeyPair>;

    /** CA certificate; `cRLSign` can be left out of its key usage. */
    async function caCertificate(
        keys: CryptoKeyPair,
        name: string,
        usages = x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
    ): Promise<string> {
        const cert = await x509.X509CertificateGenerator.createSelfSigned(
            {
                serialNumber: "01",
                name,
                notBefore: new Date(Date.now() - 60_000),
                notAfter: new Date(Date.now() + 3_600_000),
                keys,
                signingAlgorithm: algorithm,
                extensions: [
                    new x509.BasicConstraintsExtension(true, undefined, true),
                    new x509.KeyUsagesExtension(usages, true),
                ],
            },
            crypto,
        );
        return cert.toString("pem");
    }

    /** Leaf certificate with serial `0a` whose CRL distribution point is `crlUrl`. */
    async function leafWithCrl(
        crlUrl: string,
        issuer: { name: string; keys: CryptoKeyPair } = {
            name: caName,
            keys: caKeys,
        },
    ): Promise<string> {
        const keys = await generateKeys();
        const cert = await x509.X509CertificateGenerator.create(
            {
                serialNumber: "0a",
                subject: "CN=leaf.example",
                issuer: issuer.name,
                notBefore: new Date(Date.now() - 60_000),
                notAfter: new Date(Date.now() + 3_600_000),
                publicKey: keys.publicKey,
                signingKey: issuer.keys.privateKey,
                signingAlgorithm: algorithm,
                extensions: [new x509.CRLDistributionPointsExtension([crlUrl])],
            },
            crypto,
        );
        return cert.toString("pem");
    }

    /** CRL by `issuer`, signed with `signingKey`, that revokes `serials`. */
    async function crl(
        signingKey: CryptoKey,
        { issuer = caName, serials = ["0a"] } = {},
    ): Promise<ArrayBuffer> {
        return (
            await x509.X509CrlGenerator.create(
                {
                    issuer,
                    nextUpdate: new Date(Date.now() + 3_600_000),
                    entries: serials.map((serialNumber) => ({
                        serialNumber,
                        revocationDate: new Date(),
                        reason: x509.X509CrlReason.keyCompromise,
                    })),
                    signingAlgorithm: algorithm,
                    signingKey,
                },
                crypto,
            )
        ).rawData;
    }

    beforeAll(async () => {
        caKeys = await generateKeys();
        caPem = await caCertificate(caKeys, caName);
        server = createServer((request, response) => {
            requests.push(request.url ?? "");
            const body = crls[request.url ?? ""];
            if (!body) {
                response.statusCode = 404;
                response.end();
                return;
            }
            response.setHeader("content-type", "application/pkix-crl");
            response.end(Buffer.from(body));
        });
        await new Promise<void>((resolve) =>
            server.listen(0, "127.0.0.1", resolve),
        );
        port = (server.address() as AddressInfo).port;
    });

    afterAll(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    beforeEach(async () => {
        requests = [];
        crls = { "/ca.crl": await crl(caKeys.privateKey) };
    });

    const service = (
        config: Record<string, boolean> = {
            OUTBOUND_URL_ALLOW_PRIVATE_NETWORK: true,
        },
    ) =>
        new CrlValidationService(
            new OutboundUrlPolicyService({
                get: vi.fn(
                    (key: string, fallback?: unknown) =>
                        config[key] ?? fallback,
                ),
            } as never),
        );

    it("fetches an HTTP distribution point without OUTBOUND_URL_ALLOW_HTTP", async () => {
        const cert = await leafWithCrl(`http://localhost:${port}/ca.crl`);

        const result = await service({
            OUTBOUND_URL_ALLOW_HTTP: false,
            OUTBOUND_URL_ALLOW_PRIVATE_NETWORK: true,
        }).checkCertificateRevocation(cert, [caPem]);

        expect(result).toMatchObject({
            isValid: false,
            reason: "keyCompromise",
        });
        expect(result.revokedAt).toBeInstanceOf(Date);
        expect(requests).toEqual(["/ca.crl"]);
    });

    it("does not fetch a distribution point on a private address", async () => {
        const cert = await leafWithCrl(`http://127.0.0.1:${port}/ca.crl`);

        const result = await service({}).checkCertificateRevocation(cert, [
            caPem,
        ]);

        expect(result.revokedAt).toBeUndefined();
        expect(result.error).toContain("Failed to validate against any CRL");
        expect(requests).toEqual([]);
    });

    it("does not count a CRL signed by another key as revocation", async () => {
        crls["/forged.crl"] = await crl((await generateKeys()).privateKey);
        const cert = await leafWithCrl(`http://localhost:${port}/forged.crl`);

        const result = await service().checkCertificateRevocation(cert, [
            caPem,
        ]);

        expect(result.isValid).toBe(false);
        expect(result.revokedAt).toBeUndefined();
        expect(result.error).toContain("Failed to validate against any CRL");
        expect(requests).toEqual(["/forged.crl"]);
    });

    it("does not report a certificate as valid from a forged empty CRL", async () => {
        crls["/forged.crl"] = await crl((await generateKeys()).privateKey, {
            serials: [],
        });
        const cert = await leafWithCrl(`http://localhost:${port}/forged.crl`);

        const result = await service().checkCertificateRevocation(cert, [
            caPem,
        ]);

        expect(result.isValid).toBe(false);
        expect(result.error).toContain("Failed to validate against any CRL");
    });

    it("does not count a CRL that names another issuer", async () => {
        crls["/other.crl"] = await crl(caKeys.privateKey, {
            issuer: "CN=other.example",
        });
        const cert = await leafWithCrl(`http://localhost:${port}/other.crl`);

        const result = await service().checkCertificateRevocation(cert, [
            caPem,
        ]);

        expect(result.revokedAt).toBeUndefined();
        expect(result.error).toContain("Failed to validate against any CRL");
    });

    it("does not count a CRL from an issuer without the cRLSign key usage", async () => {
        const keys = await generateKeys();
        const name = "CN=no-crl-sign.example";
        const issuerPem = await caCertificate(
            keys,
            name,
            x509.KeyUsageFlags.keyCertSign,
        );
        crls["/no-crl-sign.crl"] = await crl(keys.privateKey, {
            issuer: name,
        });
        const cert = await leafWithCrl(
            `http://localhost:${port}/no-crl-sign.crl`,
            { name, keys },
        );

        const result = await service().checkCertificateRevocation(cert, [
            issuerPem,
        ]);

        expect(result.revokedAt).toBeUndefined();
        expect(result.error).toContain("Failed to validate against any CRL");
    });

    it("does not cache a forged CRL", async () => {
        const crlService = service();
        crls["/ca.crl"] = await crl((await generateKeys()).privateKey);
        const first = await crlService.checkCertificateRevocation(
            await leafWithCrl(`http://localhost:${port}/ca.crl`),
            [caPem],
        );
        crls["/ca.crl"] = await crl(caKeys.privateKey);
        const second = await crlService.checkCertificateRevocation(
            await leafWithCrl(`http://localhost:${port}/ca.crl`),
            [caPem],
        );

        expect(first.revokedAt).toBeUndefined();
        expect(second.revokedAt).toBeInstanceOf(Date);
        expect(requests).toEqual(["/ca.crl", "/ca.crl"]);
    });

    it("finds the issuer among other certificates in the chain", async () => {
        const cert = await leafWithCrl(`http://localhost:${port}/ca.crl`);
        const unrelatedPem = await caCertificate(await generateKeys(), caName);

        const result = await service().checkCertificateRevocation(cert, [
            unrelatedPem,
            caPem,
        ]);

        expect(result.revokedAt).toBeInstanceOf(Date);
    });

    it("does not fetch the CRL when the issuer certificate is not in the chain", async () => {
        const cert = await leafWithCrl(`http://localhost:${port}/ca.crl`);
        const sameNameOtherKey = await caCertificate(
            await generateKeys(),
            caName,
        );

        const result = await service().checkCertificateRevocation(cert, [
            sameNameOtherKey,
        ]);

        expect(result.isValid).toBe(false);
        expect(result.revokedAt).toBeUndefined();
        expect(result.error).toContain("Issuer certificate not in the chain");
        expect(requests).toEqual([]);
    });

    it("skips the CRL check for a self-signed certificate", async () => {
        const keys = await generateKeys();
        const cert = await x509.X509CertificateGenerator.createSelfSigned(
            {
                serialNumber: "0a",
                name: caName,
                notBefore: new Date(Date.now() - 60_000),
                notAfter: new Date(Date.now() + 3_600_000),
                keys,
                signingAlgorithm: algorithm,
                extensions: [
                    new x509.CRLDistributionPointsExtension([
                        `http://localhost:${port}/ca.crl`,
                    ]),
                ],
            },
            crypto,
        );

        const result = await service().checkCertificateRevocation(
            cert.toString("pem"),
        );

        expect(result.isValid).toBe(true);
        expect(requests).toEqual([]);
    });
});
