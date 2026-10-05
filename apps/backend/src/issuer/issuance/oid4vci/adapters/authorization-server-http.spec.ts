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
import { OutboundUrlPolicyService } from "../../../../webhook/outbound-url-policy.service.js";
import {
    authorizationServerFetch,
    getAuthorizationServerJson,
    requestAuthorizationServer,
} from "./authorization-server-http.js";

/**
 * Real requests against a local server: requests to external and upstream
 * authorization servers go through the outbound URL policy.
 */
describe("authorization server requests", () => {
    let server: Server;
    let localhost: string;
    let loopbackIp: string;
    let requests: { method?: string; url?: string; body: string }[];

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
                    body,
                });
                if (request.url === "/redirect") {
                    response.writeHead(307, { location: `${loopbackIp}/ok` });
                    response.end();
                    return;
                }
                if (request.url === "/missing") {
                    response.writeHead(404);
                    response.end();
                    return;
                }
                if (request.url === "/empty") {
                    response.writeHead(204);
                    response.end();
                    return;
                }
                response.setHeader("content-type", "application/json");
                response.end(
                    JSON.stringify({
                        accept: request.headers.accept,
                        contentType: request.headers["content-type"],
                        body,
                    }),
                );
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

    describe("getAuthorizationServerJson", () => {
        it("applies the outbound URL policy", async () => {
            await expect(
                getAuthorizationServerJson(policy(), `${loopbackIp}/ok`),
            ).rejects.toThrow("must use HTTPS");
            await expect(
                getAuthorizationServerJson(
                    policy({ OUTBOUND_URL_ALLOW_HTTP: true }),
                    `${loopbackIp}/ok`,
                ),
            ).rejects.toThrow("private or loopback IP");
            expect(requests).toEqual([]);
        });

        it("fetches JSON when the policy allows the target", async () => {
            await expect(
                getAuthorizationServerJson(permissive(), `${localhost}/ok`, {
                    accept: "application/jwk-set+json",
                }),
            ).resolves.toEqual({
                accept: "application/jwk-set+json",
                body: "",
            });
        });

        it("checks every redirect hop", async () => {
            await expect(
                getAuthorizationServerJson(
                    permissive(),
                    `${localhost}/redirect`,
                ),
            ).resolves.toMatchObject({ accept: "application/json" });
            expect(requests.map(({ url }) => url)).toEqual([
                "/redirect",
                "/ok",
            ]);

            // The first hop is a trusted origin; the redirect target is not.
            requests = [];
            await expect(
                getAuthorizationServerJson(
                    policy({ OUTBOUND_URL_ALLOW_HTTP: true }),
                    `${localhost}/redirect`,
                    { trustedOrigins: [localhost] },
                ),
            ).rejects.toThrow("private or loopback IP");
            expect(requests.map(({ url }) => url)).toEqual(["/redirect"]);
        });

        it("exempts trusted origins", async () => {
            await expect(
                getAuthorizationServerJson(policy(), `${localhost}/ok`, {
                    trustedOrigins: [localhost],
                }),
            ).resolves.toMatchObject({ accept: "application/json" });
        });

        it("rejects error responses", async () => {
            await expect(
                getAuthorizationServerJson(
                    permissive(),
                    `${localhost}/missing`,
                ),
            ).rejects.toThrow("failed with status code 404");
        });
    });

    describe("requestAuthorizationServer", () => {
        const post = (
            outboundUrlPolicy: OutboundUrlPolicyService,
            url: string,
        ) =>
            requestAuthorizationServer(http, outboundUrlPolicy, {
                url,
                method: "POST",
                headers: {
                    "content-type": "application/x-www-form-urlencoded",
                },
                body: "code=abc",
            });

        it("applies the outbound URL policy before sending", async () => {
            await expect(post(policy(), `${loopbackIp}/ok`)).rejects.toThrow(
                "must use HTTPS",
            );
            await expect(
                post(
                    policy({ OUTBOUND_URL_ALLOW_HTTP: true }),
                    `${localhost}/ok`,
                ),
            ).rejects.toThrow("not allowed in this environment");
            expect(requests).toEqual([]);
        });

        it("sends the request when the policy allows the target", async () => {
            const response = await post(permissive(), `${localhost}/ok`);
            expect(response.status).toBe(200);
            expect(JSON.parse(response.data)).toMatchObject({
                contentType: "application/x-www-form-urlencoded",
                body: "code=abc",
            });
        });

        it("does not follow redirects", async () => {
            const response = await post(permissive(), `${localhost}/redirect`);
            expect(response.status).toBe(307);
            expect(requests.map(({ url }) => url)).toEqual(["/redirect"]);
        });

        it("checks the connected address (DNS rebinding)", async () => {
            const outboundUrlPolicy = policy({ OUTBOUND_URL_ALLOW_HTTP: true });
            // A hostname that passed the up-front check with a public address
            // and resolves to a private one when connecting.
            vi.spyOn(outboundUrlPolicy, "assertSafeUrl").mockResolvedValue();
            await expect(
                post(outboundUrlPolicy, `${localhost}/ok`),
            ).rejects.toThrow("private or loopback IP");
            expect(requests).toEqual([]);
        });
    });

    describe("authorizationServerFetch", () => {
        it("returns the response for the library", async () => {
            const fetch = authorizationServerFetch(http, permissive());
            const response = await fetch(`${localhost}/ok`, {
                method: "POST",
                headers: new Headers({
                    "Content-Type": "application/x-www-form-urlencoded",
                }),
                body: "token=opaque",
            });
            expect(response.status).toBe(200);
            expect(response.headers.get("content-type")).toBe(
                "application/json",
            );
            await expect(response.json()).resolves.toMatchObject({
                contentType: "application/x-www-form-urlencoded",
                body: "token=opaque",
            });

            const empty = await fetch(`${localhost}/empty`);
            expect(empty.status).toBe(204);
            expect(requests.at(-1)).toMatchObject({ method: "GET" });
        });

        it("applies the outbound URL policy", async () => {
            await expect(
                authorizationServerFetch(http, policy())(`${loopbackIp}/ok`, {
                    method: "POST",
                    body: "token=opaque",
                }),
            ).rejects.toThrow("must use HTTPS");
            expect(requests).toEqual([]);
        });
    });
});
