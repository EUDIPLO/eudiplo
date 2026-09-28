import { BadRequestException } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MetadataFetchService } from "./metadata-fetch.service.js";

describe("MetadataFetchService", () => {
    const configService = {
        get: vi.fn().mockReturnValue("test"),
    } as unknown as ConfigService;
    const service = new MetadataFetchService(configService);

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("canonicalizes issuer URLs", () => {
        expect(
            service.buildCredentialIssuerMetadataUrl(
                "https://issuer.example/tenant/",
            ),
        ).toBe(
            "https://issuer.example/.well-known/openid-credential-issuer/tenant",
        );
    });

    it("rejects query parameters on issuer URLs", () => {
        expect(() =>
            service.buildCredentialIssuerMetadataUrl(
                "https://issuer.example?tenant=one",
            ),
        ).toThrow(BadRequestException);
    });

    it("normalizes raw JWT responses", async () => {
        vi.stubGlobal(
            "fetch",
            vi
                .fn()
                .mockResolvedValue(
                    new Response("header.payload.signature", { status: 200 }),
                ),
        );

        await expect(
            service.fetch("https://issuer.example/meta"),
        ).resolves.toEqual({ signedJwt: "header.payload.signature" });
    });
});
