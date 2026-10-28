import { webcrypto } from "node:crypto";
import * as x509 from "@peculiar/x509";
import { beforeAll, describe, expect, it } from "vitest";
import {
    defaultKeyChainUsageRefusal,
    pickDefaultAccessKeyChain,
} from "./default-access-key-chain.js";

const algorithm = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
const crypto = webcrypto as Crypto;
const hour = 3_600_000;

function generateKeys() {
    return crypto.subtle.generateKey(algorithm, true, [
        "sign",
        "verify",
    ]) as Promise<CryptoKeyPair>;
}

async function selfSigned(name: string, notAfter = Date.now() + hour) {
    const cert = await x509.X509CertificateGenerator.createSelfSigned(
        {
            serialNumber: "01",
            name,
            notBefore: new Date(Date.now() - hour),
            notAfter: new Date(notAfter),
            signingAlgorithm: algorithm,
            keys: await generateKeys(),
        },
        crypto,
    );
    return cert.toString("pem");
}

/** A leaf issued by a separate CA, as the registrar issues it. */
async function issued(
    notAfter = Date.now() + hour,
    notBefore = Date.now() - hour,
) {
    const caKeys = await generateKeys();
    const leafKeys = await generateKeys();
    const cert = await x509.X509CertificateGenerator.create(
        {
            serialNumber: "02",
            subject: "CN=Relying party",
            issuer: "CN=Registrar CA",
            notBefore: new Date(notBefore),
            notAfter: new Date(notAfter),
            signingAlgorithm: algorithm,
            publicKey: leafKeys.publicKey,
            signingKey: caKeys.privateKey,
        },
        crypto,
    );
    return cert.toString("pem");
}

describe("pickDefaultAccessKeyChain", () => {
    let selfSignedPem: string;
    let issuedPem: string;
    let expiredIssuedPem: string;
    let rootPem: string;

    beforeAll(async () => {
        selfSignedPem = await selfSigned("CN=Access key");
        issuedPem = await issued();
        expiredIssuedPem = await issued(Date.now() - 60_000);
        rootPem = await selfSigned("CN=Internal root");
    });

    const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes));

    it("prefers a registrar certificate over an older self-signed one", () => {
        const chosen = pickDefaultAccessKeyChain([
            { id: "a", createdAt: at(0), activeCertificate: selfSignedPem },
            { id: "b", createdAt: at(1), activeCertificate: issuedPem },
        ]);
        expect(chosen?.id).toBe("b");
    });

    it("prefers an internal chain over a self-signed certificate", () => {
        const chosen = pickDefaultAccessKeyChain([
            { id: "a", createdAt: at(0), activeCertificate: selfSignedPem },
            {
                id: "b",
                createdAt: at(1),
                activeCertificate: issuedPem,
                rootCertificate: rootPem,
            },
        ]);
        expect(chosen?.id).toBe("b");
    });

    it("prefers a valid self-signed certificate over an expired registrar certificate", () => {
        const chosen = pickDefaultAccessKeyChain([
            { id: "a", createdAt: at(0), activeCertificate: expiredIssuedPem },
            { id: "b", createdAt: at(1), activeCertificate: selfSignedPem },
        ]);
        expect(chosen?.id).toBe("b");
    });

    it("prefers a valid certificate over an expired one of the same kind", () => {
        const chosen = pickDefaultAccessKeyChain([
            { id: "a", createdAt: at(0), activeCertificate: expiredIssuedPem },
            { id: "b", createdAt: at(1), activeCertificate: issuedPem },
        ]);
        expect(chosen?.id).toBe("b");
    });

    it("keeps the key chain created first among equal certificates, whatever the input order", () => {
        const first = {
            id: "z",
            createdAt: at(0),
            activeCertificate: issuedPem,
        };
        const second = {
            id: "a",
            createdAt: at(1),
            activeCertificate: issuedPem,
        };
        expect(pickDefaultAccessKeyChain([second, first])?.id).toBe("z");
        expect(pickDefaultAccessKeyChain([first, second])?.id).toBe("z");
    });

    it("falls back to the smaller id for key chains created at the same time", () => {
        const chosen = pickDefaultAccessKeyChain([
            { id: "b", createdAt: at(0), activeCertificate: issuedPem },
            { id: "a", createdAt: at(0), activeCertificate: issuedPem },
        ]);
        expect(chosen?.id).toBe("a");
    });

    it("returns undefined without candidates", () => {
        expect(pickDefaultAccessKeyChain([])).toBeUndefined();
    });

    it("ranks an unreadable certificate like a self-signed one", () => {
        const chosen = pickDefaultAccessKeyChain([
            { id: "a", createdAt: at(0), activeCertificate: "garbage" },
            { id: "b", createdAt: at(1), activeCertificate: selfSignedPem },
            { id: "c", createdAt: at(2), activeCertificate: issuedPem },
        ]);
        expect(chosen?.id).toBe("c");
    });

    it("prefers a certificate that is already valid over one not yet valid", async () => {
        const notYetValid = await issued(
            Date.now() + 2 * hour,
            Date.now() + hour,
        );
        const chosen = pickDefaultAccessKeyChain([
            { id: "a", createdAt: at(0), activeCertificate: notYetValid },
            { id: "b", createdAt: at(1), activeCertificate: issuedPem },
        ]);
        expect(chosen?.id).toBe("b");
    });
});

describe("defaultKeyChainUsageRefusal", () => {
    it("accepts a key chain whose usage type matches the entry", () => {
        expect(
            defaultKeyChainUsageRefusal("access", "registrar", "access"),
        ).toBeUndefined();
    });

    it("names the entry and the usage type it needs", () => {
        expect(
            defaultKeyChainUsageRefusal("access", "pid", "attestation"),
        ).toBe(
            'Key chain "pid" has usage type "attestation"; the default access key chain needs usage type "access".',
        );
    });
});
