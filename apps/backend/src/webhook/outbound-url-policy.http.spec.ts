import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { OutboundUrlPolicyService } from "./outbound-url-policy.service.js";

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

    it("rejects private addresses in the lookup used for connections", async () => {
        const service = policy({ OUTBOUND_URL_ALLOW_PRIVATE_NETWORK: false });
        const error = await new Promise<Error | null>((resolve) =>
            service.safeLookup("localhost", {}, (err) => resolve(err)),
        );
        expect(error?.message).toContain("private or loopback IP");
    });
});
