import * as x509 from "@peculiar/x509";
import { beforeAll, describe, expect, it } from "vitest";
import {
    certificateBase64,
    entityInfoIssues,
    externalEntityCertificates,
    TrustListInputError,
} from "./trust-list-input.js";

let pem: string;
let der: string;

beforeAll(async () => {
    x509.cryptoProvider.set(globalThis.crypto);
    const keys = await globalThis.crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["sign", "verify"],
    );
    const certificate = await x509.X509CertificateGenerator.createSelfSigned({
        name: "CN=Issuer",
        keys,
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    });
    pem = certificate.toString("pem");
    der = certificate.toString("base64");
});

describe("certificateBase64", () => {
    it("reads PEM and Base64 DER, also with line breaks", () => {
        expect(certificateBase64(pem)).toBe(der);
        expect(certificateBase64(der.replaceAll(/(.{64})/g, "$1\n"))).toBe(der);
    });

    it.each([
        ["blank", "  "],
        ["no certificate", "bm90IGEgY2VydGlmaWNhdGU="],
        ["a broken PEM", "-----BEGIN CERTIFICATE-----\nAAAA"],
    ])("gives undefined for %s", (_, value) => {
        expect(certificateBase64(value)).toBeUndefined();
    });
});

describe("externalEntityCertificates", () => {
    it("parses the certificates of external entities and names each field that holds none", () => {
        const { certificates, issues } = externalEntityCertificates([
            { type: "external", issuerCertPem: pem, revocationCertPem: der },
            {
                type: "external",
                issuerCertPem: "nope",
                revocationCertPem: der,
            },
            { type: "internal" },
        ]);

        expect(certificates).toEqual(
            new Map([[0, { issuerCertPem: der, revocationCertPem: der }]]),
        );
        expect(issues).toEqual([
            {
                path: ["entities", 1, "issuerCertPem"],
                code: "invalid_certificate",
                message:
                    "issuerCertPem must be an X.509 certificate in PEM or Base64 DER.",
            },
        ]);
    });
});

describe("entityInfoIssues", () => {
    it("accepts unset values and values a LoTE document can hold", () => {
        expect(
            entityInfoIssues([
                { info: {} },
                { info: { country: "DE", uri: "https://issuer.example" } },
                { info: { country: "", uri: "" } },
            ]),
        ).toEqual([]);
    });

    it("refuses a country of other than two characters and a relative uri", () => {
        expect(
            entityInfoIssues([
                { info: { country: "DEU", uri: "issuer.example" } },
                { info: { country: "D" } },
            ]),
        ).toEqual([
            expect.objectContaining({
                path: ["entities", 0, "info", "country"],
                code: "invalid_entity_info",
            }),
            expect.objectContaining({
                path: ["entities", 0, "info", "uri"],
                code: "invalid_entity_info",
            }),
            expect.objectContaining({
                path: ["entities", 1, "info", "country"],
            }),
        ]);
    });
});

describe("TrustListInputError", () => {
    it("lists top-level fields first, then the entities in order, and names each path in the message", () => {
        const error = new TrustListInputError([
            {
                path: ["entities", 1, "issuerCertPem"],
                message: "b",
                code: "invalid_certificate",
            },
            {
                path: ["entities", 0, "info", "uri"],
                message: "c",
                code: "invalid_entity_info",
            },
            {
                path: ["entities", 0, "issuerKeyChainId"],
                message: "d",
                code: "key_chain_not_found",
            },
            {
                path: ["keyChainId"],
                message: "a",
                code: "key_chain_usage_mismatch",
            },
        ]);

        expect(error.issues.map(({ message }) => message)).toEqual([
            "a",
            "c",
            "d",
            "b",
        ]);
        expect(error.message).toBe(
            "keyChainId: a; entities.0.info.uri: c; entities.0.issuerKeyChainId: d; entities.1.issuerCertPem: b",
        );
    });
});
