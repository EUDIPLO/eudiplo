import { BadRequestException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MetadataFetchService } from "./metadata-fetch.service.js";

describe("MetadataFetchService", () => {
    const outbound = { get: vi.fn() };
    const service = new MetadataFetchService(outbound as never);

    beforeEach(() => {
        outbound.get.mockReset();
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
        outbound.get.mockResolvedValue({
            status: 200,
            body: "header.payload.signature",
        });

        await expect(
            service.fetch("https://issuer.example/meta"),
        ).resolves.toEqual({ signedJwt: "header.payload.signature" });
        expect(outbound.get).toHaveBeenCalledWith(
            "https://issuer.example/meta",
            expect.objectContaining({
                headers: { accept: "application/json" },
                timeoutMs: 5000,
            }),
        );
    });

    it("checks every redirect hop against the outbound policy", async () => {
        outbound.get
            .mockResolvedValueOnce({ status: 302, location: "/next", body: "" })
            .mockResolvedValueOnce({ status: 200, body: '{"ok":true}' });

        await expect(
            service.fetch("https://issuer.example/meta"),
        ).resolves.toEqual({ ok: true });
        expect(outbound.get).toHaveBeenNthCalledWith(
            2,
            "https://issuer.example/next",
            expect.anything(),
        );
    });

    it("maps policy rejections and HTTP errors to bad requests", async () => {
        outbound.get.mockRejectedValueOnce(
            new BadRequestException("Outbound URL host is not allowed"),
        );
        await expect(
            service.fetch("https://internal.example/meta"),
        ).rejects.toThrow("Outbound URL host is not allowed");

        outbound.get.mockResolvedValueOnce({ status: 500, body: "" });
        await expect(
            service.fetch("https://issuer.example/meta"),
        ).rejects.toThrow("HTTP 500");
    });

    it("rejects userinfo in URLs before any request", async () => {
        await expect(
            service.fetch("https://user:pass@issuer.example/meta"),
        ).rejects.toThrow("userinfo");
        expect(outbound.get).not.toHaveBeenCalled();
    });
});
