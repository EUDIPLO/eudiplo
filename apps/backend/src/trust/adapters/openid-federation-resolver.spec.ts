import { describe, expect, it, vi } from "vitest";
import { OpenIdFederationResolver } from "./openid-federation-resolver.js";

/** A {@link TrustFetchService} stub that answers with the given bodies. */
const fetching = (...bodies: string[]) => {
    const get = vi.fn();
    for (const body of bodies) get.mockResolvedValueOnce({ body });
    return get;
};

const jwt = (payload: Record<string, unknown>) =>
    [
        Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
        Buffer.from(JSON.stringify(payload)).toString("base64url"),
        "signature",
    ].join(".");

describe("OpenIdFederationResolver", () => {
    it("fetches the well-known endpoint and parses JSON entity configuration", async () => {
        const get = fetching(JSON.stringify({ sub: "https://entity.example" }));
        const resolver = new OpenIdFederationResolver({ get });

        await expect(
            resolver.resolveEntityConfiguration("https://entity.example/"),
        ).resolves.toEqual({ sub: "https://entity.example" });
        expect(get).toHaveBeenCalledWith(
            "https://entity.example/.well-known/openid-federation",
            { timeoutMs: 5000, maxBytes: 1024 * 1024 },
        );
    });

    it("normalizes compact entity configuration JWTs, bare and wrapped in JSON", async () => {
        const compact = jwt({
            sub: "https://entity.example",
            authority_hints: ["https://anchor.example"],
        });
        const get = fetching(
            compact,
            JSON.stringify({ entity_configuration: compact }),
        );
        const resolver = new OpenIdFederationResolver({ get });
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
        const resolver = new OpenIdFederationResolver({ get: fetching("42") });

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
            get: fetching(compact),
        });

        await expect(
            resolver.resolveEntityConfiguration("https://entity.example"),
        ).rejects.toThrow();
    });
});
