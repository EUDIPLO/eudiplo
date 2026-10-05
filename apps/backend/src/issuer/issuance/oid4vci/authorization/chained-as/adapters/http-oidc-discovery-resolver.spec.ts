import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { OutboundUrlPolicyService } from "../../../../../../webhook/outbound-url-policy.service.js";
import { HttpOidcDiscoveryResolver } from "./http-oidc-discovery-resolver.js";

describe("HttpOidcDiscoveryResolver", () => {
    it("fetches the discovery document under the outbound URL policy", async () => {
        const requests: string[] = [];
        const server = createServer((request, response) => {
            requests.push(request.url ?? "");
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify({ issuer: "upstream" }));
        });
        await new Promise<void>((resolve) =>
            server.listen(0, "127.0.0.1", resolve),
        );
        const { port } = server.address() as AddressInfo;
        const issuer = `http://127.0.0.1:${port}/realms/test/`;
        const resolver = (config: Record<string, boolean>) =>
            new HttpOidcDiscoveryResolver(
                new OutboundUrlPolicyService({
                    get: vi.fn(
                        (key: string, fallback?: unknown) =>
                            config[key] ?? fallback,
                    ),
                } as never),
            );
        try {
            // The 9.0 defaults: HTTPS only, no private addresses.
            await expect(resolver({}).resolve(issuer)).rejects.toThrow(
                "must use HTTPS",
            );
            await expect(
                resolver({ OUTBOUND_URL_ALLOW_HTTP: true }).resolve(issuer),
            ).rejects.toThrow("private or loopback IP");
            expect(requests).toEqual([]);

            await expect(
                resolver({
                    OUTBOUND_URL_ALLOW_HTTP: true,
                    OUTBOUND_URL_ALLOW_PRIVATE_NETWORK: true,
                }).resolve(issuer),
            ).resolves.toEqual({ issuer: "upstream" });
            expect(requests).toEqual([
                "/realms/test/.well-known/openid-configuration",
            ]);
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });
});
