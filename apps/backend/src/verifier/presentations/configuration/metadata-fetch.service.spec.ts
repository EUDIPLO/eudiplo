import { BadRequestException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MetadataFetchService } from "./metadata-fetch.service.js";

describe("MetadataFetchService", () => {
    const outbound = { getFollowingRedirects: vi.fn() };
    const service = new MetadataFetchService(outbound as never);

    beforeEach(() => {
        outbound.getFollowingRedirects.mockReset();
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
        outbound.getFollowingRedirects.mockResolvedValue({
            status: 200,
            url: "https://issuer.example/meta",
            body: "header.payload.signature",
        });

        await expect(
            service.fetch("https://issuer.example/meta"),
        ).resolves.toEqual({ signedJwt: "header.payload.signature" });
        expect(outbound.getFollowingRedirects).toHaveBeenCalledWith(
            "https://issuer.example/meta",
            expect.objectContaining({
                headers: { accept: "application/json" },
                timeoutMs: 5000,
                maxRedirects: 3,
            }),
        );
    });

    it("maps policy rejections and HTTP errors to bad requests", async () => {
        outbound.getFollowingRedirects.mockRejectedValueOnce(
            new BadRequestException("Outbound URL host is not allowed"),
        );
        await expect(
            service.fetch("https://internal.example/meta"),
        ).rejects.toThrow("Outbound URL host is not allowed");

        outbound.getFollowingRedirects.mockResolvedValueOnce({
            status: 500,
            url: "https://issuer.example/meta",
            body: "",
        });
        await expect(
            service.fetch("https://issuer.example/meta"),
        ).rejects.toThrow("HTTP 500");
    });

    it("wraps transport errors and rejects non-JSON bodies", async () => {
        outbound.getFollowingRedirects.mockRejectedValueOnce(
            new Error("socket hang up"),
        );
        await expect(
            service.fetch("https://issuer.example/meta"),
        ).rejects.toThrow(
            "Failed to fetch issuer metadata from https://issuer.example/meta: socket hang up",
        );

        outbound.getFollowingRedirects.mockResolvedValueOnce({
            status: 200,
            url: "https://issuer.example/final",
            body: "<html></html>",
        });
        await expect(
            service.fetch("https://issuer.example/meta"),
        ).rejects.toThrow(
            "Issuer metadata response from https://issuer.example/final is not valid JSON or JWT",
        );
    });

    it("rejects userinfo in URLs before any request", async () => {
        await expect(
            service.fetch("https://user:pass@issuer.example/meta"),
        ).rejects.toThrow("userinfo");
        expect(outbound.getFollowingRedirects).not.toHaveBeenCalled();
    });
});
