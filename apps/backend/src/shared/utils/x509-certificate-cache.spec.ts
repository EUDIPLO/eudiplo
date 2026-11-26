import "reflect-metadata";
import { webcrypto } from "node:crypto";
import * as x509 from "@peculiar/x509";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
    parseX509Certificate,
    parseX509CertificateDer,
} from "./x509-certificate-cache.js";

describe("parseX509Certificate", () => {
    let pem: string;
    let base64Der: string;

    beforeAll(async () => {
        const algorithm = {
            name: "ECDSA",
            namedCurve: "P-256",
            hash: "SHA-256",
        };
        const keys = await webcrypto.subtle.generateKey(algorithm, true, [
            "sign",
            "verify",
        ]);
        const cert = await x509.X509CertificateGenerator.createSelfSigned(
            {
                serialNumber: "01",
                name: "CN=cache-test",
                notBefore: new Date(Date.now() - 60_000),
                notAfter: new Date(Date.now() + 3_600_000),
                keys,
                signingAlgorithm: algorithm,
            },
            webcrypto,
        );
        pem = cert.toString("pem");
        base64Der = Buffer.from(cert.rawData).toString("base64");
    });

    it("parses PEM and base64 DER into the same certificate", () => {
        const fromPem = parseX509Certificate(pem);
        const fromDer = parseX509Certificate(base64Der);

        expect(fromPem.subject).toBe("CN=cache-test");
        expect(Buffer.from(fromDer.rawData)).toEqual(
            Buffer.from(fromPem.rawData),
        );
    });

    it("reuses the parsed certificate for the same encoding", () => {
        expect(parseX509Certificate(pem)).toBe(parseX509Certificate(pem));
    });

    it("ignores whitespace in base64 DER, as in trust lists", () => {
        const wrapped = base64Der.replace(/(.{64})/g, "$1\n");

        expect(parseX509Certificate(wrapped)).toBe(
            parseX509Certificate(base64Der),
        );
    });

    it("shares the entry between DER bytes and their base64 encoding", () => {
        const der = Buffer.from(base64Der, "base64");

        expect(parseX509CertificateDer(new Uint8Array(der))).toBe(
            parseX509Certificate(base64Der),
        );
        expect(parseX509CertificateDer(Uint8Array.from(der))).toBe(
            parseX509CertificateDer(new Uint8Array(der)),
        );
    });

    it("throws for a value that is not a certificate", () => {
        expect(() => parseX509Certificate("bm90IGEgY2VydA==")).toThrow();
    });

    it("does not accept hex-encoded DER", () => {
        const hex = Buffer.from(base64Der, "base64").toString("hex");

        expect(() => parseX509Certificate(hex)).toThrow();
    });

    it("parses a certificate again once its entry has expired", () => {
        vi.useFakeTimers();
        try {
            const first = parseX509Certificate(pem);
            vi.advanceTimersByTime(60 * 60 * 1000);

            expect(parseX509Certificate(pem)).not.toBe(first);
        } finally {
            vi.useRealTimers();
        }
    });
});
