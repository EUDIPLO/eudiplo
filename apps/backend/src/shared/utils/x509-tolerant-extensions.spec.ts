import * as x509 from "@peculiar/x509";
import { beforeAll, describe, expect, it } from "vitest";
import { CertificatePathBuilder } from "./certificate-path.util.js";
import {
    registerTolerantX509Extensions,
    TolerantIssuerAlternativeNameExtension,
} from "./x509-tolerant-extensions.js";

/**
 * Official EU Age Verification reference-implementation IACA certificate
 * ("Age Verification Issuer CA 01"). Its issuerAltName extension is malformed:
 * the extension value wraps a full nested Extension structure around the
 * GeneralNames. Source:
 * https://github.com/eu-digital-identity-wallet/av-srv-web-issuing-avw-py
 * (api_docs/test_tokens/IACA-token/AgeVerificationIssuer.IACA.01.EU.pem)
 */
const AV_IACA_PEM = `-----BEGIN CERTIFICATE-----
MIIC0zCCAnigAwIBAgIUVDLDFa4rz+IkYiwCyN+cH86e3bcwCgYIKoZIzj0EAwMw
aTEmMCQGA1UEAwwdQWdlIFZlcmlmaWNhdGlvbiBJc3N1ZXIgQ0EgMDExMjAwBgNV
BAoMKUFnZSBWZXJpZmljYXRpb24gUmVmZXJlbmNlIEltcGxlbWVudGF0aW9uMQsw
CQYDVQQGEwJFVTAeFw0yNTA3MDExMDI0MjJaFw0zNDA5MjcxMDI0MjFaMGkxJjAk
BgNVBAMMHUFnZSBWZXJpZmljYXRpb24gSXNzdWVyIENBIDAxMTIwMAYDVQQKDClB
Z2UgVmVyaWZpY2F0aW9uIFJlZmVyZW5jZSBJbXBsZW1lbnRhdGlvbjELMAkGA1UE
BhMCRVUwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAARZWSqRomweuXy6u3fvxPpQ
cGk1XGy6FermzmY6KMuc6jGzIp10NglnbdRMxMt1oxbFK322VvoDZKgDs2sokynD
o4H9MIH6MBIGA1UdEwEB/wQIMAYBAf8CAQAwHwYDVR0jBBgwFoAUy3CVgEyZHtxt
C3z+6+BByiJULtgwEwYDVR0lBAwwCgYIK4ECAgAAAQcwRAYDVR0fBD0wOzA5oDeg
NYYzaHR0cHM6Ly9pc3N1ZXIuYWdldmVyaWZpY2F0aW9uLmRldi9wa2kvRVVfQ0Ff
MDEuY3JsMB0GA1UdDgQWBBTLcJWATJke3G0LfP7r4EHKIlQu2DAOBgNVHQ8BAf8E
BAMCAQYwOQYDVR0SBDIwMAYDVR0SBCkwJ4IlaHR0cHM6Ly9jb21taXNzaW9uLmV1
cm9wYS5ldS9pbmRleF9lbjAKBggqhkjOPQQDAwNJADBGAiEAqaDOzWyw0piVvMYp
lBkRHchgXxONwAG5W70Ent/WDQUCIQDZvjN/4xosNu91CEql+F52u+5g0NRPR5Gy
GpJGwpRf1A==
-----END CERTIFICATE-----`;

describe("registerTolerantX509Extensions (malformed AV issuerAltName)", () => {
    beforeAll(() => {
        registerTolerantX509Extensions();
    });

    it("parses all extensions of the AV IACA certificate without throwing", () => {
        const cert = new x509.X509Certificate(AV_IACA_PEM);
        expect(() => cert.extensions).not.toThrow();
        expect(cert.extensions.length).toBeGreaterThan(0);
    });

    it("recovers the GeneralNames from the nested-Extension variant", () => {
        const cert = new x509.X509Certificate(AV_IACA_PEM);
        const ian = cert.extensions.find(
            (e) => e.type === "2.5.29.18",
        ) as TolerantIssuerAlternativeNameExtension;
        expect(ian).toBeInstanceOf(TolerantIssuerAlternativeNameExtension);
        expect(ian.names).toBeDefined();
        expect(JSON.stringify(ian.names!.toJSON())).toContain(
            "commission.europa.eu",
        );
    });

    it("CertificatePathBuilder can build a path involving the AV IACA", async () => {
        const cert = new x509.X509Certificate(AV_IACA_PEM);
        const builder = new CertificatePathBuilder([cert]);
        const chain = await builder.build(cert);
        expect(chain.length).toBe(1);
    });

    it("getExtension works on the AV IACA (used by trust validation)", () => {
        const cert = new x509.X509Certificate(AV_IACA_PEM);
        const bc = cert.getExtension("2.5.29.19");
        expect(bc).toBeDefined();
    });
});
