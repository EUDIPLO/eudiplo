import { of } from "rxjs";
import { describe, expect, it, vi } from "vitest";
import { OpenIdFederationResolver } from "./openid-federation-resolver.js";

const jwt = (payload: Record<string, unknown>) =>
    [
        Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
        Buffer.from(JSON.stringify(payload)).toString("base64url"),
        "signature",
    ].join(".");

describe("OpenIdFederationResolver", () => {
    it("fetches the well-known endpoint and parses JSON entity configuration", async () => {
        const get = vi
            .fn()
            .mockReturnValue(
                of({ data: JSON.stringify({ sub: "https://entity.example" }) }),
            );
        const resolver = new OpenIdFederationResolver({ get } as never);

        await expect(
            resolver.resolveEntityConfiguration("https://entity.example/"),
        ).resolves.toEqual({ sub: "https://entity.example" });
        expect(get).toHaveBeenCalledWith(
            "https://entity.example/.well-known/openid-federation",
            { responseType: "text", timeout: 5000 },
        );
    });

    it("normalizes compact entity configuration JWTs from strings and objects", async () => {
        const compact = jwt({
            sub: "https://entity.example",
            authority_hints: ["https://anchor.example"],
        });
        const get = vi
            .fn()
            .mockReturnValueOnce(of({ data: compact }))
            .mockReturnValueOnce(
                of({ data: { entity_configuration: compact } }),
            );
        const resolver = new OpenIdFederationResolver({ get } as never);
        const expected = {
            sub: "https://entity.example",
            authority_hints: ["https://anchor.example"],
        };

        await expect(
            resolver.resolveEntityConfiguration("https://entity.example"),
        ).resolves.toEqual(expected);
        await expect(
            resolver.resolveEntityConfiguration("https://entity.example"),
        ).resolves.toEqual(expected);
    });

    it("rejects unsupported response shapes", async () => {
        const resolver = new OpenIdFederationResolver({
            get: vi.fn().mockReturnValue(of({ data: 42 })),
        } as never);

        await expect(
            resolver.resolveEntityConfiguration("https://entity.example"),
        ).rejects.toThrow(
            "Unsupported federation entity configuration response for https://entity.example",
        );
    });

    it("rejects signed entity configurations with an invalid x5c signature", async () => {
        const compact = [
            Buffer.from(
                JSON.stringify({
                    alg: "ES256",
                    x5c: [Buffer.from("not-a-certificate").toString("base64")],
                }),
            ).toString("base64url"),
            Buffer.from(
                JSON.stringify({ sub: "https://entity.example" }),
            ).toString("base64url"),
            "invalid-signature",
        ].join(".");
        const resolver = new OpenIdFederationResolver({
            get: vi.fn().mockReturnValue(of({ data: compact })),
        } as never);

        await expect(
            resolver.resolveEntityConfiguration("https://entity.example"),
        ).rejects.toThrow();
    });
});
