import type { HttpService } from "@nestjs/axios";
import type { MetricService } from "nestjs-otel";
import { of, throwError } from "rxjs";
import { describe, expect, it, vi } from "vitest";
import type { FederationTrustService } from "../../../../trust/federation-trust.service.js";
import type { FederationTrustSource } from "../../../../trust/types.js";
import {
    AuthorizationServerMetadataUnavailable,
    AuthorizationServerNotTrusted,
} from "../domain/authorization-server-errors.js";
import { HttpExternalAuthorizationServerMetadataResolver } from "./http-external-authorization-server-metadata-resolver.js";

const issuer = "https://as.example.org";
const metadata = { issuer, token_endpoint: `${issuer}/token` };

function setup(get: ReturnType<typeof vi.fn>, trusted = true) {
    const federation = {
        getMode: vi.fn((source?: FederationTrustSource) => source?.mode),
        evaluateAuthorizationServerTrust: vi.fn(async () => ({
            trusted,
            reason: trusted ? undefined : "no trust chain",
        })),
    };
    const add = vi.fn();
    const resolver = new HttpExternalAuthorizationServerMetadataResolver(
        { get } as unknown as HttpService,
        federation as unknown as FederationTrustService,
        { getCounter: () => ({ add }) } as unknown as MetricService,
    );
    return { resolver, federation, add };
}

describe("HttpExternalAuthorizationServerMetadataResolver", () => {
    it("caches metadata and deduplicates concurrent in-flight requests", async () => {
        const get = vi.fn().mockReturnValue(of({ data: metadata }));
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
        );
    });

    it("falls back to openid-configuration and fails with a transport-neutral error", async () => {
        const fallback = vi
            .fn()
            .mockReturnValueOnce(throwError(() => new Error("404")))
            .mockReturnValueOnce(of({ data: metadata }));
        await expect(setup(fallback).resolver.resolve(issuer)).resolves.toEqual(
            metadata,
        );
        expect(fallback).toHaveBeenLastCalledWith(
            `${issuer}/.well-known/openid-configuration`,
        );

        const failing = vi
            .fn()
            .mockReturnValue(throwError(() => new Error("down")));
        await expect(setup(failing).resolver.resolve(issuer)).rejects.toThrow(
            AuthorizationServerMetadataUnavailable,
        );
    });

    it("serves stale metadata when a refresh fails", async () => {
        const get = vi
            .fn()
            .mockReturnValueOnce(of({ data: metadata }))
            .mockReturnValue(throwError(() => new Error("Upstream error")));
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
        const get = vi.fn().mockReturnValue(of({ data: metadata }));
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
});
