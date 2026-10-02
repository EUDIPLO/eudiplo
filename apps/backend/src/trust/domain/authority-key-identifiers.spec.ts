import * as x509 from "@peculiar/x509";
import { beforeAll, describe, expect, it } from "vitest";
import { ServiceTypeIdentifiers, type TrustedEntity } from "../types.js";
import { credentialIssuerAuthorityKeyIdentifiers } from "./authority-key-identifiers.js";

const signingAlgorithm = { name: "ECDSA", hash: "SHA-256" };
const generateKeys = () =>
    globalThis.crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["sign", "verify"],
    ) as Promise<CryptoKeyPair>;

const der = (cert: x509.X509Certificate) =>
    Buffer.from(cert.rawData).toString("base64");
const ski = (cert: x509.X509Certificate) =>
    Buffer.from(
        cert.getExtension(x509.SubjectKeyIdentifierExtension)!.keyId,
        "hex",
    ).toString("base64url");

const entity = (...services: Array<[string, string]>): TrustedEntity => ({
    entityId: "Issuer",
    services: services.map(([serviceTypeIdentifier, certValue]) => ({
        serviceTypeIdentifier,
        certValue,
    })),
});

describe("credentialIssuerAuthorityKeyIdentifiers", () => {
    let ca: x509.X509Certificate;
    let leaf: x509.X509Certificate;
    let otherCa: x509.X509Certificate;
    let selfSignedLeaf: x509.X509Certificate;

    beforeAll(async () => {
        x509.cryptoProvider.set(globalThis.crypto);
        const caKeys = await generateKeys();
        ca = await x509.X509CertificateGenerator.createSelfSigned({
            name: "CN=Issuer CA",
            keys: caKeys,
            signingAlgorithm,
            extensions: [
                new x509.BasicConstraintsExtension(true, 0, true),
                await x509.SubjectKeyIdentifierExtension.create(
                    caKeys.publicKey,
                ),
            ],
        });
        const leafKeys = await generateKeys();
        leaf = await x509.X509CertificateGenerator.create({
            subject: "CN=Issuer Signer",
            issuer: ca.subject,
            publicKey: leafKeys.publicKey,
            signingKey: caKeys.privateKey,
            signingAlgorithm,
            extensions: [
                new x509.BasicConstraintsExtension(false),
                await x509.SubjectKeyIdentifierExtension.create(
                    leafKeys.publicKey,
                ),
                await x509.AuthorityKeyIdentifierExtension.create(
                    caKeys.publicKey,
                ),
            ],
        });
        const otherKeys = await generateKeys();
        otherCa = await x509.X509CertificateGenerator.createSelfSigned({
            name: "CN=Other CA",
            keys: otherKeys,
            signingAlgorithm,
            extensions: [
                new x509.BasicConstraintsExtension(true),
                await x509.SubjectKeyIdentifierExtension.create(
                    otherKeys.publicKey,
                ),
            ],
        });
        // Like standalone key chains: a self-signed signer without AKI.
        const standaloneKeys = await generateKeys();
        selfSignedLeaf = await x509.X509CertificateGenerator.createSelfSigned({
            name: "CN=Standalone Signer",
            keys: standaloneKeys,
            signingAlgorithm,
            extensions: [
                new x509.BasicConstraintsExtension(false),
                await x509.SubjectKeyIdentifierExtension.create(
                    standaloneKeys.publicKey,
                ),
            ],
        });
    });

    it("uses the SKI of a listed CA, which its credentials carry as AKI", () => {
        expect(
            credentialIssuerAuthorityKeyIdentifiers([
                entity([ServiceTypeIdentifiers.EaaIssuance, der(ca)]),
            ]),
        ).toEqual({ values: [ski(ca)], complete: true });
        // The listed CA's key identifier is what the leaf references.
        expect(
            Buffer.from(
                leaf.getExtension(x509.AuthorityKeyIdentifierExtension)!.keyId!,
                "hex",
            ).toString("base64url"),
        ).toBe(ski(ca));
    });

    it("adds the own AKI of a pinned leaf so credentials it signs match", () => {
        expect(
            credentialIssuerAuthorityKeyIdentifiers([
                entity([ServiceTypeIdentifiers.PIDIssuance, der(leaf)]),
            ]),
        ).toEqual({ values: [ski(leaf), ski(ca)], complete: true });
    });

    it("de-duplicates values across services and entities", () => {
        expect(
            credentialIssuerAuthorityKeyIdentifiers([
                entity(
                    [ServiceTypeIdentifiers.EaaIssuance, der(ca)],
                    [ServiceTypeIdentifiers.EaaIssuance, der(leaf)],
                ),
                entity([ServiceTypeIdentifiers.PIDIssuance, der(ca)]),
            ]).values,
        ).toEqual([ski(ca), ski(leaf)]);
    });

    it("only uses PID and EAA issuance services", () => {
        expect(
            credentialIssuerAuthorityKeyIdentifiers([
                entity(
                    [ServiceTypeIdentifiers.EaaRevocation, der(otherCa)],
                    [
                        ServiceTypeIdentifiers.WalletSolutionIssuance,
                        der(otherCa),
                    ],
                    [ServiceTypeIdentifiers.EaaIssuance, der(ca)],
                ),
            ]),
        ).toEqual({ values: [ski(ca)], complete: true });
        expect(credentialIssuerAuthorityKeyIdentifiers([])).toEqual({
            values: [],
            complete: true,
        });
    });

    it("accepts PEM certificates", () => {
        expect(
            credentialIssuerAuthorityKeyIdentifiers([
                entity([
                    ServiceTypeIdentifiers.PIDIssuance,
                    ca.toString("pem"),
                ]),
            ]),
        ).toEqual({ values: [ski(ca)], complete: true });
    });

    it("reports issuers that no key identifier can match", async () => {
        const keys = await generateKeys();
        const caWithoutSki =
            await x509.X509CertificateGenerator.createSelfSigned({
                name: "CN=No SKI",
                keys,
                signingAlgorithm,
                extensions: [new x509.BasicConstraintsExtension(true)],
            });

        for (const unusable of [
            "not a certificate",
            der(caWithoutSki),
            der(selfSignedLeaf),
        ]) {
            expect(
                credentialIssuerAuthorityKeyIdentifiers([
                    entity(
                        [ServiceTypeIdentifiers.EaaIssuance, der(ca)],
                        [ServiceTypeIdentifiers.EaaIssuance, unusable],
                    ),
                ]),
            ).toEqual({
                values:
                    unusable === der(selfSignedLeaf)
                        ? [ski(ca), ski(selfSignedLeaf)]
                        : [ski(ca)],
                complete: false,
            });
        }
    });
});
