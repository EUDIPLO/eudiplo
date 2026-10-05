import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { MetricService } from "nestjs-otel";
import { describe, expect, it, vi } from "vitest";
import type { FederationTrustService } from "../../../../trust/federation-trust.service.js";
import type { FederationTrustSource } from "../../../../trust/types.js";
import { OutboundUrlPolicyService } from "../../../../webhook/outbound-url-policy.service.js";
import {
    AuthorizationServerMetadataUnavailable,
    AuthorizationServerNotTrusted,
} from "../domain/authorization-server-errors.js";
import { HttpExternalAuthorizationServerMetadataResolver } from "./http-external-authorization-server-metadata-resolver.js";

const issuer = "https://as.example.org";
const metadata = { issuer, token_endpoint: `${issuer}/token` };

/** A response of {@link OutboundUrlPolicyService.getFollowingRedirects}. */
const ok = (body: unknown) => ({
    status: 200,
    body: JSON.stringify(body),
    url: issuer,
});

function setup(
    getFollowingRedirects: ReturnType<typeof vi.fn>,
    trusted = true,
) {
    const federation = {
        getMode: vi.fn((source?: FederationTrustSource) => source?.mode),
        evaluateAuthorizationServerTrust: vi.fn(async () => ({
            trusted,
            reason: trusted ? undefined : "no trust chain",
        })),
    };
    const add = vi.fn();
    const resolver = new HttpExternalAuthorizationServerMetadataResolver(
        { getFollowingRedirects } as unknown as OutboundUrlPolicyService,
        federation as unknown as FederationTrustService,
        { getCounter: () => ({ add }) } as unknown as MetricService,
    );
    return { resolver, federation, add };
}

describe("HttpExternalAuthorizationServerMetadataResolver", () => {
    it("caches metadata and deduplicates concurrent in-flight requests", async () => {
        const get = vi.fn().mockResolvedValue(ok(metadata));
        const { resolver } = setup(get);

        const results = await Promise.all([
            resolver.resolve(issuer),
            resolver.resolve(issuer),
            resolver.resolve(issuer),
        ]);
        expect(results.map((result) => result.issuer)).toEqual([
            issuer,
            issuer,
            issuer,
        ]);
        expect(get).toHaveBeenCalledTimes(1);

        await resolver.resolve(issuer);
        expect(get).toHaveBeenCalledTimes(1);
        expect(get).toHaveBeenCalledWith(
            `${issuer}/.well-known/oauth-authorization-server`,
            expect.anything(),
        );
    });

    it("falls back to openid-configuration and fails with a transport-neutral error", async () => {
        const fallback = vi
            .fn()
            .mockResolvedValueOnce({ status: 404, body: "", url: issuer })
            .mockResolvedValueOnce(ok(metadata));
        await expect(setup(fallback).resolver.resolve(issuer)).resolves.toEqual(
            metadata,
        );
        expect(fallback).toHaveBeenLastCalledWith(
            `${issuer}/.well-known/openid-configuration`,
            expect.anything(),
        );

        const failing = vi.fn().mockRejectedValue(new Error("down"));
        await expect(setup(failing).resolver.resolve(issuer)).rejects.toThrow(
            AuthorizationServerMetadataUnavailable,
        );
    });

    it("serves stale metadata when a refresh fails", async () => {
        const get = vi
            .fn()
            .mockResolvedValueOnce(ok(metadata))
            .mockRejectedValue(new Error("Upstream error"));
        const { resolver } = setup(get);
        await resolver.resolve(issuer);

        vi.useFakeTimers({ now: Date.now() + 6 * 60 * 1000 });
        try {
            await expect(resolver.resolve(issuer)).resolves.toEqual(metadata);
            expect(get).toHaveBeenCalledTimes(3);

            vi.setSystemTime(Date.now() + 60 * 60 * 1000);
            await expect(resolver.resolve(issuer)).rejects.toThrow(
                AuthorizationServerMetadataUnavailable,
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it("checks federation trust before fetching unless the mode is lote-only", async () => {
        const source = {
            mode: "hybrid",
            trustAnchors: [],
        } as unknown as FederationTrustSource;
        const get = vi.fn().mockResolvedValue(ok(metadata));
        const untrusted = setup(get, false);

        await expect(
            untrusted.resolver.resolve(issuer, source),
        ).rejects.toThrow(new AuthorizationServerNotTrusted("no trust chain"));
        expect(get).not.toHaveBeenCalled();

        const loteOnly = setup(get, false);
        await expect(
            loteOnly.resolver.resolve(issuer, {
                ...source,
                mode: "lote-only",
            } as FederationTrustSource),
        ).resolves.toEqual(metadata);
        expect(
            loteOnly.federation.evaluateAuthorizationServerTrust,
        ).not.toHaveBeenCalled();
    });

    it("fetches metadata under the outbound URL policy", async () => {
        const requests: string[] = [];
        const server = createServer((request, response) => {
            requests.push(request.url ?? "");
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify(metadata));
        });
        await new Promise<void>((resolve) =>
            server.listen(0, "127.0.0.1", resolve),
        );
        const { port } = server.address() as AddressInfo;
        const upstream = `http://127.0.0.1:${port}`;
        const resolver = (config: Record<string, boolean>) =>
            new HttpExternalAuthorizationServerMetadataResolver(
                new OutboundUrlPolicyService({
                    get: (key: string, fallback?: unknown) =>
                        config[key] ?? fallback,
                } as never),
                {} as FederationTrustService,
            );
        try {
            // The 9.0 defaults: HTTPS only, no private addresses.
            await expect(resolver({}).resolve(upstream)).rejects.toThrow(
                AuthorizationServerMetadataUnavailable,
            );
            await expect(
                resolver({ OUTBOUND_URL_ALLOW_HTTP: true }).resolve(upstream),
            ).rejects.toThrow(AuthorizationServerMetadataUnavailable);
            expect(requests).toEqual([]);

            await expect(
                resolver({
                    OUTBOUND_URL_ALLOW_HTTP: true,
                    OUTBOUND_URL_ALLOW_PRIVATE_NETWORK: true,
                }).resolve(upstream),
            ).resolves.toEqual(metadata);
            expect(requests).toEqual([
                "/.well-known/oauth-authorization-server",
            ]);
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });
});
