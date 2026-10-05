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

describe("CrlValidationService", () => {
    let server: Server;
    let port: number;
    let crl: ArrayBuffer;
    let requests: string[];

    /** Self-signed certificate whose CRL distribution point is `crlUrl`. */
    async function certificateWithCrl(crlUrl: string): Promise<string> {
        const keys = await crypto.subtle.generateKey(algorithm, true, [
            "sign",
            "verify",
        ]);
        const cert = await x509.X509CertificateGenerator.createSelfSigned(
            {
                serialNumber: "0a",
                name: "CN=issuer.example",
                notBefore: new Date(Date.now() - 60_000),
                notAfter: new Date(Date.now() + 3_600_000),
                keys,
                signingAlgorithm: algorithm,
                extensions: [new x509.CRLDistributionPointsExtension([crlUrl])],
            },
            crypto,
        );
        return cert.toString("pem");
    }

    beforeAll(async () => {
        const keys = await crypto.subtle.generateKey(algorithm, true, [
            "sign",
            "verify",
        ]);
        crl = (
            await x509.X509CrlGenerator.create(
                {
                    issuer: "CN=issuer.example",
                    nextUpdate: new Date(Date.now() + 3_600_000),
                    entries: [
                        { serialNumber: "0a", revocationDate: new Date() },
                    ],
                    signingAlgorithm: algorithm,
                    signingKey: keys.privateKey,
                },
                crypto,
            )
        ).rawData;
        server = createServer((request, response) => {
            requests.push(request.url ?? "");
            response.setHeader("content-type", "application/pkix-crl");
            response.end(Buffer.from(crl));
        });
        await new Promise<void>((resolve) =>
            server.listen(0, "127.0.0.1", resolve),
        );
        port = (server.address() as AddressInfo).port;
    });

    afterAll(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    beforeEach(() => {
        requests = [];
    });

    const service = (config: Record<string, boolean> = {}) =>
        new CrlValidationService(
            new OutboundUrlPolicyService({
                get: vi.fn(
                    (key: string, fallback?: unknown) =>
                        config[key] ?? fallback,
                ),
            } as never),
        );

    it("fetches an HTTP distribution point without OUTBOUND_URL_ALLOW_HTTP", async () => {
        const cert = await certificateWithCrl(
            `http://localhost:${port}/ca.crl`,
        );

        const result = await service({
            OUTBOUND_URL_ALLOW_HTTP: false,
            OUTBOUND_URL_ALLOW_PRIVATE_NETWORK: true,
        }).checkCertificateRevocation(cert);

        expect(result).toMatchObject({ isValid: false });
        expect(result.revokedAt).toBeInstanceOf(Date);
        expect(requests).toEqual(["/ca.crl"]);
    });

    it("does not fetch a distribution point on a private address", async () => {
        const cert = await certificateWithCrl(
            `http://127.0.0.1:${port}/ca.crl`,
        );

        const result = await service().checkCertificateRevocation(cert);

        expect(result.revokedAt).toBeUndefined();
        expect(result.error).toContain("Failed to validate against any CRL");
        expect(requests).toEqual([]);
    });
});
