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
import { OutboundUrlPolicyService } from "../../../../../../webhook/outbound-url-policy.service.js";
import { HttpOidcTokenExchanger } from "./http-oidc-token-exchanger.js";

/** Real requests against a local upstream token endpoint. */
describe("HttpOidcTokenExchanger", () => {
    let server: Server;
    let upstream: string;
    let requests: { url?: string; contentType?: string; body: string }[];

    beforeAll(async () => {
        server = createServer((request, response) => {
            let body = "";
            request.on("data", (chunk) => {
                body += chunk;
            });
            request.on("end", () => {
                requests.push({
                    url: request.url,
                    contentType: request.headers["content-type"],
                    body,
                });
                if (request.url === "/redirect") {
                    response.writeHead(307, { location: "/token" });
                    response.end();
                    return;
                }
                if (request.url === "/error") {
                    response.writeHead(400, {
                        "content-type": "application/json",
                    });
                    response.end(JSON.stringify({ error: "invalid_grant" }));
                    return;
                }
                response.setHeader("content-type", "application/json");
                response.end(
                    JSON.stringify({
                        access_token: "access-token",
                        id_token: "id-token",
                        token_type: "Bearer",
                    }),
                );
            });
        });
        await new Promise<void>((resolve) =>
            server.listen(0, "127.0.0.1", resolve),
        );
        const { port } = server.address() as AddressInfo;
        upstream = `http://127.0.0.1:${port}`;
    });

    afterAll(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    beforeEach(() => {
        requests = [];
    });

    const exchanger = (config: Record<string, boolean>) =>
        new HttpOidcTokenExchanger(
            new HttpService(axios.create()),
            new OutboundUrlPolicyService({
                get: vi.fn(
                    (key: string, fallback?: unknown) =>
                        config[key] ?? fallback,
                ),
            } as never),
        );
    const permissive = () =>
        exchanger({
            OUTBOUND_URL_ALLOW_HTTP: true,
            OUTBOUND_URL_ALLOW_PRIVATE_NETWORK: true,
        });
    const input = (tokenEndpoint: string) => ({
        tokenEndpoint,
        code: "authorization-code",
        redirectUri: "https://issuer.example.org/callback",
        clientId: "client-id",
        clientSecret: "client-secret",
        codeVerifier: "pkce-verifier",
    });

    it("sends the authorization-code exchange form and maps the token response", async () => {
        await expect(
            permissive().exchange(input(`${upstream}/token`)),
        ).resolves.toEqual({
            accessToken: "access-token",
            idToken: "id-token",
        });
        expect(requests).toHaveLength(1);
        expect(requests[0].contentType).toBe(
            "application/x-www-form-urlencoded",
        );
        expect(
            Object.fromEntries(new URLSearchParams(requests[0].body)),
        ).toEqual({
            grant_type: "authorization_code",
            code: "authorization-code",
            redirect_uri: "https://issuer.example.org/callback",
            client_id: "client-id",
            client_secret: "client-secret",
            code_verifier: "pkce-verifier",
        });
    });

    it("applies the outbound URL policy to the token endpoint", async () => {
        // The 9.0 defaults: HTTPS only, no private addresses.
        await expect(
            exchanger({}).exchange(input(`${upstream}/token`)),
        ).rejects.toThrow("must use HTTPS");
        await expect(
            exchanger({ OUTBOUND_URL_ALLOW_HTTP: true }).exchange(
                input(`${upstream}/token`),
            ),
        ).rejects.toThrow("private or loopback IP");
        expect(requests).toEqual([]);
    });

    it("does not follow redirects", async () => {
        await expect(
            permissive().exchange(input(`${upstream}/redirect`)),
        ).rejects.toThrow("status code 307");
        expect(requests.map(({ url }) => url)).toEqual(["/redirect"]);
    });

    it("rejects error responses", async () => {
        await expect(
            permissive().exchange(input(`${upstream}/error`)),
        ).rejects.toThrow("status code 400");
    });
});
