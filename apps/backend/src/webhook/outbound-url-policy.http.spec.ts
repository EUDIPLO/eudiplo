import { createPrivateKey, webcrypto } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import * as x509 from "@peculiar/x509";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { OutboundUrlPolicyService } from "./outbound-url-policy.service.js";

/** Key and self-signed certificate for an HTTPS server on localhost. */
async function selfSignedTls() {
    const algorithm = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
    const keys = await webcrypto.subtle.generateKey(algorithm, true, [
        "sign",
        "verify",
    ]);
    const cert = await x509.X509CertificateGenerator.createSelfSigned(
        {
            serialNumber: "01",
            name: "CN=localhost",
            notBefore: new Date(Date.now() - 60_000),
            notAfter: new Date(Date.now() + 3_600_000),
            keys,
            signingAlgorithm: algorithm,
            extensions: [
                new x509.SubjectAlternativeNameExtension([
                    { type: "dns", value: "localhost" },
                ]),
            ],
        },
        webcrypto as Crypto,
    );
    const pkcs8 = await webcrypto.subtle.exportKey("pkcs8", keys.privateKey);
    const key = createPrivateKey({
        key: Buffer.from(pkcs8),
        format: "der",
        type: "pkcs8",
    }).export({ format: "pem", type: "pkcs8" }) as string;
    return { key, cert: cert.toString("pem") };
}

/** Real sockets against a local server; complements the mocked policy spec. */
describe("OutboundUrlPolicyService outbound requests", () => {
    let server: Server;
    let baseUrl: string;

    beforeAll(async () => {
        server = createServer((request, response) => {
            if (request.url === "/redirect") {
                response.writeHead(302, { location: "/json" });
                response.end();
                return;
            }
            if (request.url === "/loop") {
                response.writeHead(302, { location: "/loop" });
                response.end();
                return;
            }
            if (request.url === "/redirect-other-origin") {
                const { port } = server.address() as AddressInfo;
                response.writeHead(302, {
                    location: `http://127.0.0.1:${port}/json`,
                });
                response.end();
                return;
            }
            if (request.url === "/large") {
                response.end("x".repeat(2048));
                return;
            }
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify({ accept: request.headers.accept }));
        });
        await new Promise<void>((resolve) =>
            server.listen(0, "127.0.0.1", resolve),
        );
        const { port } = server.address() as AddressInfo;
        baseUrl = `http://localhost:${port}`;
    });

    afterAll(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    const policy = (config: Record<string, boolean | string> = {}) =>
        new OutboundUrlPolicyService({
            get: vi.fn(
                (key: string, fallback?: unknown) => config[key] ?? fallback,
            ),
        } as never);

    const options = { timeoutMs: 2000, maxBytes: 1024 };

    it("fetches when private targets are allowed", async () => {
        const response = await policy({
            OUTBOUND_URL_ALLOW_HTTP: true,
            OUTBOUND_URL_ALLOW_PRIVATE_NETWORK: true,
        }).get(`${baseUrl}/json`, {
            ...options,
            headers: { accept: "application/json" },
        });
        expect(response).toMatchObject({ status: 200 });
        expect(JSON.parse(response.body)).toEqual({
            accept: "application/json",
        });
    });

    it("returns redirects without following them", async () => {
        const response = await policy({
            OUTBOUND_URL_ALLOW_HTTP: true,
            OUTBOUND_URL_ALLOW_PRIVATE_NETWORK: true,
        }).get(`${baseUrl}/redirect`, options);
        expect(response).toMatchObject({ status: 302, location: "/json" });
    });

    it("follows redirects and reports the final URL, content type and bytes", async () => {
        const response = await policy({
            OUTBOUND_URL_ALLOW_HTTP: true,
            OUTBOUND_URL_ALLOW_PRIVATE_NETWORK: true,
        }).getFollowingRedirects(`${baseUrl}/redirect`, {
            ...options,
            maxRedirects: 1,
        });
        expect(response).toMatchObject({
            status: 200,
            url: `${baseUrl}/json`,
            contentType: "application/json",
        });
        expect(response.bytes.toString("utf8")).toBe(response.body);
    });

    it("stops after the redirect limit", async () => {
        await expect(
            policy({
                OUTBOUND_URL_ALLOW_HTTP: true,
                OUTBOUND_URL_ALLOW_PRIVATE_NETWORK: true,
            }).getFollowingRedirects(`${baseUrl}/loop`, {
                ...options,
                maxRedirects: 2,
            }),
        ).rejects.toThrow("exceeded 2 redirects");
    });

    it("applies the policy to every redirect hop", async () => {
        const service = policy({
            OUTBOUND_URL_ALLOW_HTTP: true,
            OUTBOUND_URL_ALLOW_PRIVATE_NETWORK: false,
        });
        // A public first hop that redirects to the cloud metadata endpoint.
        const get = vi.spyOn(service, "get").mockResolvedValueOnce({
            status: 302,
            location: "http://169.254.169.254/latest/meta-data",
            body: "",
            bytes: Buffer.alloc(0),
        });
        await expect(
            service.getFollowingRedirects("https://public.example/rulebook", {
                ...options,
                maxRedirects: 3,
            }),
        ).rejects.toThrow("private or loopback IP");
        expect(get).toHaveBeenNthCalledWith(
            2,
            "http://169.254.169.254/latest/meta-data",
            expect.anything(),
        );
    });

    it("aborts responses larger than the limit", async () => {
        await expect(
            policy({
                OUTBOUND_URL_ALLOW_HTTP: true,
                OUTBOUND_URL_ALLOW_PRIVATE_NETWORK: true,
            }).get(`${baseUrl}/large`, options),
        ).rejects.toThrow("exceeds 1024 bytes");
    });

    it("blocks a private address at connect time even if the URL check passed (DNS rebinding)", async () => {
        const service = policy({
            OUTBOUND_URL_ALLOW_HTTP: true,
            OUTBOUND_URL_ALLOW_PRIVATE_NETWORK: false,
        });
        // Simulate a hostname that resolved to a public address during the
        // up-front check and to a private one when connecting.
        vi.spyOn(service, "assertSafeUrl").mockResolvedValue(undefined);
        await expect(service.get(`${baseUrl}/json`, options)).rejects.toThrow(
            "private or loopback IP",
        );
    });

    it("skips the policy for trusted origins", async () => {
        const response = await policy({
            OUTBOUND_URL_ALLOW_HTTP: false,
            OUTBOUND_URL_ALLOW_PRIVATE_NETWORK: false,
        }).get(`${baseUrl}/json`, {
            ...options,
            trustedOrigins: [`${baseUrl}/`],
        });
        expect(response).toMatchObject({ status: 200 });
    });

    it("checks a redirect from a trusted origin to another origin", async () => {
        await expect(
            policy({
                OUTBOUND_URL_ALLOW_HTTP: true,
                OUTBOUND_URL_ALLOW_PRIVATE_NETWORK: false,
            }).getFollowingRedirects(`${baseUrl}/redirect-other-origin`, {
                ...options,
                maxRedirects: 1,
                trustedOrigins: [baseUrl],
            }),
        ).rejects.toThrow("private or loopback IP");
    });

    it("allows HTTP per request with allowHttp, keeping the address check", async () => {
        const service = policy({
            OUTBOUND_URL_ALLOW_HTTP: false,
            OUTBOUND_URL_ALLOW_PRIVATE_NETWORK: true,
        });
        await expect(service.get(`${baseUrl}/json`, options)).rejects.toThrow(
            "must use HTTPS",
        );
        await expect(
            service.get(`${baseUrl}/json`, { ...options, allowHttp: true }),
        ).resolves.toMatchObject({ status: 200 });
        await expect(
            policy({
                OUTBOUND_URL_ALLOW_HTTP: false,
                OUTBOUND_URL_ALLOW_PRIVATE_NETWORK: false,
            }).get(`${baseUrl}/json`, { ...options, allowHttp: true }),
        ).rejects.toThrow("not allowed in this environment");
    });

    it("verifies TLS certificates unless rejectUnauthorized is false", async () => {
        const tls = await selfSignedTls();
        const httpsServer = createHttpsServer(tls, (_request, response) =>
            response.end("ok"),
        );
        await new Promise<void>((resolve) =>
            httpsServer.listen(0, "127.0.0.1", resolve),
        );
        const { port } = httpsServer.address() as AddressInfo;
        const url = `https://localhost:${port}/`;
        const service = policy({ OUTBOUND_URL_ALLOW_PRIVATE_NETWORK: true });
        try {
            await expect(service.get(url, options)).rejects.toThrow(
                /self[- ]signed/,
            );
            // An explicit undefined must not switch verification off.
            await expect(
                service.get(url, { ...options, rejectUnauthorized: undefined }),
            ).rejects.toThrow(/self[- ]signed/);
            await expect(
                service.get(url, { ...options, rejectUnauthorized: false }),
            ).resolves.toMatchObject({ status: 200, body: "ok" });
        } finally {
            await new Promise<void>((resolve) =>
                httpsServer.close(() => resolve()),
            );
        }
        // The first verified TLS connection loads the CA store, which can
        // take seconds on developer machines.
    }, 20_000);

    it("rejects private addresses in the lookup used for connections", async () => {
        const service = policy({ OUTBOUND_URL_ALLOW_PRIVATE_NETWORK: false });
        const error = await new Promise<Error | null>((resolve) =>
            service.safeLookup("localhost", {}, (err) => resolve(err)),
        );
        expect(error?.message).toContain("private or loopback IP");
    });
});
