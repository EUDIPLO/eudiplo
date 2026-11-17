import { webcrypto, X509Certificate } from "node:crypto";
import * as x509 from "@peculiar/x509";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { outboundFetch } from "../webhook/outbound-fetch.js";
import { IssuingCaService } from "./issuing-ca.service.js";

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("../webhook/outbound-fetch.js", () => ({
    outboundFetch: vi.fn(() => fetchMock),
}));

const crypto = webcrypto as Crypto;
const algorithm = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };

async function keyPair(): Promise<CryptoKeyPair> {
    return (await crypto.subtle.generateKey(algorithm, true, [
        "sign",
        "verify",
    ])) as CryptoKeyPair;
}

describe("IssuingCaService outbound requests", () => {
    it("fetches through the outbound URL policy with a deadline, a size cap and few redirects", () => {
        const policy = { assertAllowed: vi.fn() };
        const http = {};
        new IssuingCaService(policy as never, http as never);

        expect(outboundFetch).toHaveBeenCalledWith(http, policy, {
            timeoutMs: 30_000,
            maxBytes: 1024 * 1024,
            maxRedirects: 3,
        });
    });
});

describe("IssuingCaService.chainFor", () => {
    const AIA = "http://ca.example/issuing.cer";

    async function ca(
        name: string,
        signer?: { keys: CryptoKeyPair; name: string },
    ) {
        const keys = await keyPair();
        const cert = await x509.X509CertificateGenerator.create(
            {
                serialNumber: "02",
                subject: name,
                issuer: signer?.name ?? name,
                notBefore: new Date(Date.now() - 60_000),
                notAfter: new Date(Date.now() + 3_600_000),
                signingAlgorithm: algorithm,
                publicKey: keys.publicKey,
                signingKey: (signer?.keys ?? keys).privateKey,
                extensions: [new x509.BasicConstraintsExtension(true, 0, true)],
            },
            crypto,
        );
        return { keys, name, pem: cert.toString("pem") };
    }

    async function leafFrom(
        issuer: { keys: CryptoKeyPair; name: string },
        key: CryptoKeyPair,
        aia = true,
    ) {
        const cert = await x509.X509CertificateGenerator.create(
            {
                serialNumber: "03",
                subject: "CN=Relying party",
                issuer: issuer.name,
                notBefore: new Date(Date.now() - 60_000),
                notAfter: new Date(Date.now() + 3_600_000),
                signingAlgorithm: algorithm,
                publicKey: key.publicKey,
                signingKey: issuer.keys.privateKey,
                extensions: aia
                    ? [
                          new x509.AuthorityInfoAccessExtension({
                              caIssuers: AIA,
                          }),
                      ]
                    : [],
            },
            crypto,
        );
        return cert.toString("pem");
    }

    let key: CryptoKeyPair;
    let fetch: ReturnType<typeof vi.fn>;
    let service: IssuingCaService;

    /** Answer the AIA request with this certificate, as DER. */
    function serve(pem: string) {
        fetch.mockResolvedValue(
            new Response(new X509Certificate(pem).raw, { status: 200 }),
        );
    }

    beforeEach(async () => {
        key = await keyPair();
        service = new IssuingCaService(
            { assertAllowed: vi.fn() } as any,
            {} as any,
        );
        // The function the outbound URL policy wrapper returns.
        fetch = fetchMock;
        fetch.mockReset();
    });

    it("adds the issuing CA the certificate names after it", async () => {
        const root = await ca("CN=Hub Root");
        const issuing = await ca("CN=Hub Issuing", root);
        const leaf = await leafFrom(issuing, key);
        serve(issuing.pem);

        const chain = await service.chainFor("t1", leaf, "EUDI Hub");

        expect(fetch).toHaveBeenCalledWith(AIA, { method: "GET" });
        expect(chain).toHaveLength(2);
        expect(new X509Certificate(chain[1]).subject).toBe("CN=Hub Issuing");
    });

    it("reads an issuing CA served as PEM", async () => {
        const root = await ca("CN=Hub Root");
        const issuing = await ca("CN=Hub Issuing", root);
        fetch.mockResolvedValue(new Response(issuing.pem, { status: 200 }));

        const chain = await service.chainFor(
            "t1",
            await leafFrom(issuing, key),
            "EUDI Hub",
        );

        expect(chain).toHaveLength(2);
    });

    it("leaves out a self-signed issuer, which is the trust anchor", async () => {
        const root = await ca("CN=Hub Root");
        const leaf = await leafFrom(root, key);
        serve(root.pem);

        expect(await service.chainFor("t1", leaf, "EUDI Hub")).toEqual([leaf]);
    });

    it("returns the certificate alone when the fetched CA did not issue it", async () => {
        const issuing = await ca("CN=Hub Issuing");
        const other = await ca("CN=Hub Issuing");
        const leaf = await leafFrom(issuing, key);
        serve(other.pem);

        expect(await service.chainFor("t1", leaf, "EUDI Hub")).toEqual([leaf]);
    });

    it("returns the certificate alone when the CA cannot be fetched, is no certificate or is not named", async () => {
        const issuing = await ca("CN=Hub Issuing");
        const leaf = await leafFrom(issuing, key);

        fetch.mockRejectedValue(
            new Error("blocked by the outbound URL policy"),
        );
        expect(await service.chainFor("t1", leaf, "EUDI Hub")).toEqual([leaf]);

        fetch.mockResolvedValue(new Response("nope", { status: 404 }));
        expect(await service.chainFor("t1", leaf, "EUDI Hub")).toEqual([leaf]);

        fetch.mockResolvedValue(new Response("not DER", { status: 200 }));
        expect(await service.chainFor("t1", leaf, "EUDI Hub")).toEqual([leaf]);

        const withoutAia = await leafFrom(issuing, key, false);
        fetch.mockClear();
        expect(await service.chainFor("t1", withoutAia, "EUDI Hub")).toEqual([
            withoutAia,
        ]);
        expect(fetch).not.toHaveBeenCalled();
    });
});
