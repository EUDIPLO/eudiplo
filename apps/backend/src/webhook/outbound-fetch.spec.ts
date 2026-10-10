import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { HttpService } from "@nestjs/axios";
import axios from "axios";
import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { outboundFetch } from "./outbound-fetch.js";
import { OutboundUrlPolicyService } from "./outbound-url-policy.service.js";

/** Real requests against a local server through the outbound URL policy. */
describe("outboundFetch", () => {
    let server: Server;
    let localhost: string;
    let loopbackIp: string;
    let requests: {
        method?: string;
        url?: string;
        contentType?: string;
        authorization?: string;
        body: string;
    }[];

    beforeAll(async () => {
        server = createServer((request, response) => {
            let body = "";
            request.on("data", (chunk) => {
                body += chunk;
            });
            request.on("end", () => {
                requests.push({
                    method: request.method,
                    url: request.url,
                    contentType: request.headers["content-type"],
                    authorization: request.headers.authorization,
                    body,
                });
                switch (request.url) {
                    case "/redirect":
                        response.writeHead(302, {
                            location: "http://169.254.169.254/latest",
                        });
                        response.end();
                        return;
                    case "/empty":
                        response.writeHead(204);
                        response.end();
                        return;
                    case "/large":
                        response.end("x".repeat(2048));
                        return;
                    case "/slow":
                        // Never answers; the client times out.
                        return;
                    default:
                        response.setHeader("content-type", "application/json");
                        response.end(JSON.stringify({ ok: true }));
                }
            });
        });
        await new Promise<void>((resolve) =>
            server.listen(0, "127.0.0.1", resolve),
        );
        const { port } = server.address() as AddressInfo;
        localhost = `http://localhost:${port}`;
        loopbackIp = `http://127.0.0.1:${port}`;
    });

    afterAll(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    beforeEach(() => {
        requests = [];
    });

    /** Policy with the 9.0 defaults: HTTPS only, no private addresses. */
    const policy = (config: Record<string, boolean> = {}) =>
        new OutboundUrlPolicyService({
            get: vi.fn(
                (key: string, fallback?: unknown) => config[key] ?? fallback,
            ),
        } as never);
    const permissive = () =>
        policy({
            OUTBOUND_URL_ALLOW_HTTP: true,
            OUTBOUND_URL_ALLOW_PRIVATE_NETWORK: true,
        });
    const http = new HttpService(axios.create());
    const limits = { timeoutMs: 2_000, maxBytes: 1024 };
    const fetchWith = (outboundUrlPolicy: OutboundUrlPolicyService) =>
        outboundFetch(http, outboundUrlPolicy, limits);

    it("applies the outbound URL policy before sending", async () => {
        await expect(fetchWith(policy())(`${loopbackIp}/ok`)).rejects.toThrow(
            "must use HTTPS",
        );
        await expect(
            fetchWith(policy({ OUTBOUND_URL_ALLOW_HTTP: true }))(
                `${loopbackIp}/ok`,
            ),
        ).rejects.toThrow("private or loopback IP");
        expect(requests).toEqual([]);
    });

    it("checks the connected address (DNS rebinding)", async () => {
        const outboundUrlPolicy = policy({ OUTBOUND_URL_ALLOW_HTTP: true });
        // A hostname that passed the up-front check with a public address
        // and resolves to a private one when connecting.
        vi.spyOn(outboundUrlPolicy, "assertSafeUrl").mockResolvedValue();
        await expect(
            fetchWith(outboundUrlPolicy)(`${localhost}/ok`),
        ).rejects.toThrow("private or loopback IP");
        expect(requests).toEqual([]);
    });

    it("keeps method, headers and body of a Request", async () => {
        // The generated registrar client calls fetch(request) without init.
        const response = await fetchWith(permissive())(
            new Request(`${localhost}/ok`, {
                method: "PUT",
                headers: {
                    authorization: "Bearer token",
                    "content-type": "application/json",
                },
                body: JSON.stringify({ name: "value" }),
            }),
        );

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ ok: true });
        expect(requests).toEqual([
            {
                method: "PUT",
                url: "/ok",
                contentType: "application/json",
                authorization: "Bearer token",
                body: '{"name":"value"}',
            },
        ]);
    });

    it("sends multipart bodies", async () => {
        const form = new FormData();
        form.append("schema", "{}");
        form.append("file", new Blob(["file content"]), "file.txt");

        await fetchWith(permissive())(`${localhost}/ok`, {
            method: "POST",
            body: form,
        });

        expect(requests[0].contentType).toMatch(
            /^multipart\/form-data; boundary=/,
        );
        expect(requests[0].body).toContain('name="schema"');
        expect(requests[0].body).toContain("file content");
    });

    it("rejects redirects and names the target", async () => {
        await expect(
            fetchWith(permissive())(`${localhost}/redirect`),
        ).rejects.toThrow(
            `Request to ${localhost}/redirect was redirected to http://169.254.169.254/latest; redirects are not followed`,
        );
        expect(requests.map(({ url }) => url)).toEqual(["/redirect"]);
    });

    it("returns an empty body for 204", async () => {
        const response = await fetchWith(permissive())(`${localhost}/empty`);
        expect(response.status).toBe(204);
        await expect(response.text()).resolves.toBe("");
    });

    it("bounds the response size", async () => {
        await expect(
            fetchWith(permissive())(`${localhost}/large`),
        ).rejects.toThrow("maxContentLength");
    });

    it("bounds the time", async () => {
        await expect(
            outboundFetch(http, permissive(), {
                timeoutMs: 100,
                maxBytes: 1024,
            })(`${localhost}/slow`),
        ).rejects.toThrow("timeout");
    });
});
