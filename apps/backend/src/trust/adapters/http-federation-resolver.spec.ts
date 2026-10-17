import { describe, expect, it, vi } from "vitest";
import { HttpFederationResolver } from "./http-federation-resolver.js";

const request = {
    entityId: "https://issuer.example.org",
    trustAnchors: [{ entityId: "https://ta.example.org" }],
    metadataTypes: ["openid_credential_issuer"],
};

const resolution = () => ({
    entityId: "https://issuer.example.org",
    trustAnchor: "https://ta.example.org",
    trustChain: ["ec", "ss", "ta"],
    metadata: { openid_credential_issuer: { jwks: { keys: [] } } },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
});

function resolverAnswering(response: Response | Error) {
    const fetch = vi.fn(async () => {
        if (response instanceof Error) throw response;
        return response;
    });
    return {
        fetch,
        resolver: new HttpFederationResolver(
            { url: "https://trust-engine.example/", token: "secret" },
            fetch as unknown as typeof globalThis.fetch,
        ),
    };
}

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });

describe("HttpFederationResolver", () => {
    it("posts the request to {url}/resolve with the bearer token", async () => {
        const { fetch, resolver } = resolverAnswering(json(resolution()));

        await expect(resolver.resolveEntity(request)).resolves.toMatchObject({
            entityId: "https://issuer.example.org",
            trustAnchor: "https://ta.example.org",
        });
        const [url, init] = fetch.mock.calls[0] as unknown as [
            string,
            RequestInit,
        ];
        expect(url).toBe("https://trust-engine.example/resolve");
        expect(init.method).toBe("POST");
        expect((init.headers as Record<string, string>).authorization).toBe(
            "Bearer secret",
        );
        expect(JSON.parse(init.body as string)).toEqual({
            entityId: "https://issuer.example.org",
            trustAnchors: ["https://ta.example.org"],
            metadataTypes: ["openid_credential_issuer"],
        });
    });

    it("treats a 4xx answer as not trusted", async () => {
        const { resolver } = resolverAnswering(
            json({ error: "no chain" }, 404),
        );

        await expect(resolver.resolveEntity(request)).rejects.toMatchObject({
            failure: "untrusted",
        });
    });

    it.each([
        ["a 5xx answer", json({}, 503)],
        ["a rejected token", json({}, 401)],
        ["a rate limit", json({}, 429)],
        [
            "a failed request",
            new Error("Request did not complete within 10 seconds"),
        ],
        ["an invalid answer", json({ entityId: "x" })],
    ])("treats %s as unavailable", async (_, answer) => {
        const { resolver } = resolverAnswering(answer);

        await expect(resolver.resolveEntity(request)).rejects.toMatchObject({
            failure: "unavailable",
        });
    });

    it.each([
        ["another entity", { entityId: "https://other.example.org" }],
        [
            "another trust anchor",
            { trustAnchor: "https://other-ta.example.org" },
        ],
        [
            "an expired chain",
            { expiresAt: new Date(Date.now() - 1000).toISOString() },
        ],
        ["no requested metadata", { metadata: { federation_entity: {} } }],
    ])("rejects a resolution of %s", async (_, change) => {
        const { resolver } = resolverAnswering(
            json({ ...resolution(), ...change }),
        );

        await expect(resolver.resolveEntity(request)).rejects.toMatchObject({
            failure: "untrusted",
        });
    });
});
