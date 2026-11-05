import { describe, expect, it, vi } from "vitest";
import type { OutboundUrlPolicyService } from "../../webhook/outbound-url-policy.service.js";
import { OidcIssuerMetadataLoader } from "./oidc-issuer-metadata.loader.js";

const ISSUER = "https://auth.example.com/application/o/eudiplo/";
const INTERNAL = "http://authentik:9000/application/o/eudiplo/";
const DOCUMENT = {
    issuer: ISSUER,
    jwks_uri: "https://auth.example.com/application/o/eudiplo/jwks/",
    token_endpoint: "https://auth.example.com/application/o/token/",
    authorization_endpoint: "https://auth.example.com/application/o/authorize/",
};

function policy(
    ...answers: (object | number | Error)[]
): OutboundUrlPolicyService & { calls: unknown[][] } {
    const calls: unknown[][] = [];
    return {
        calls,
        get: vi.fn(async (...args: unknown[]) => {
            calls.push(args);
            const next = answers.shift() ?? new Error("connect ECONNREFUSED");
            if (next instanceof Error) throw next;
            return typeof next === "number"
                ? { status: next, body: "" }
                : { status: 200, body: JSON.stringify(next) };
        }),
    } as never;
}

/** A clock that only moves while the loader sleeps. */
function clock() {
    let now = 0;
    return {
        now: () => now,
        sleep: vi.fn(async (ms: number) => {
            now += ms;
        }),
    };
}

describe("OidcIssuerMetadataLoader", () => {
    it("loads the discovery document from the internal issuer URL and trusts only its origin", async () => {
        const outbound = policy(DOCUMENT);

        const metadata = await new OidcIssuerMetadataLoader(outbound).load({
            issuer: ISSUER,
            internalIssuer: INTERNAL,
        });

        expect(metadata).toEqual({
            issuer: ISSUER,
            jwks_uri: DOCUMENT.jwks_uri,
            token_endpoint: DOCUMENT.token_endpoint,
        });
        expect(outbound.calls[0][0]).toBe(
            "http://authentik:9000/application/o/eudiplo/.well-known/openid-configuration",
        );
        expect(outbound.calls[0][1]).toMatchObject({
            trustedOrigins: ["http://authentik:9000"],
        });
    });

    it("retries while the identity provider is not up yet", async () => {
        const time = clock();
        const outbound = policy(
            new Error("connect ECONNREFUSED"),
            503,
            DOCUMENT,
        );

        const metadata = await new OidcIssuerMetadataLoader(outbound).load({
            issuer: ISSUER,
            internalIssuer: INTERNAL,
            ...time,
        });

        expect(metadata.issuer).toBe(ISSUER);
        expect(time.sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000]);
    });

    it("fails startup once the retry time is over", async () => {
        const time = clock();

        await expect(
            new OidcIssuerMetadataLoader(policy()).load({
                issuer: ISSUER,
                internalIssuer: INTERNAL,
                retryMs: 10_000,
                ...time,
            }),
        ).rejects.toThrow(
            "Could not load the OIDC discovery document from http://authentik:9000/application/o/eudiplo/.well-known/openid-configuration: connect ECONNREFUSED",
        );
        expect(time.sleep.mock.calls.map(([ms]) => ms)).toEqual([
            1000, 2000, 4000, 5000,
        ]);
    });

    it("fails at once when the document names another issuer", async () => {
        const time = clock();

        await expect(
            new OidcIssuerMetadataLoader(
                policy({ ...DOCUMENT, issuer: ISSUER.slice(0, -1) }),
            ).load({ issuer: ISSUER, internalIssuer: INTERNAL, ...time }),
        ).rejects.toThrow(
            `the document names the issuer '${ISSUER.slice(0, -1)}', but OIDC is '${ISSUER}'`,
        );
        expect(time.sleep).not.toHaveBeenCalled();
    });

    it("fails at once for a document without keys, which retrying cannot fix", async () => {
        const time = clock();

        await expect(
            new OidcIssuerMetadataLoader(
                policy({
                    issuer: ISSUER,
                    token_endpoint: DOCUMENT.token_endpoint,
                }),
            ).load({ issuer: ISSUER, internalIssuer: INTERNAL, ...time }),
        ).rejects.toThrow("the document has no valid jwks_uri");
        expect(time.sleep).not.toHaveBeenCalled();
    });

    it("refuses keys over plain HTTP at another origin, where they could be replaced", async () => {
        const time = clock();

        await expect(
            new OidcIssuerMetadataLoader(
                policy({
                    ...DOCUMENT,
                    jwks_uri: "http://keys.example.com/jwks",
                }),
            ).load({ issuer: ISSUER, internalIssuer: INTERNAL, ...time }),
        ).rejects.toThrow(
            "the document names the key set 'http://keys.example.com/jwks', which is neither HTTPS nor at the origin of the discovery document. Set OIDC_JWKS_URI",
        );
        expect(time.sleep).not.toHaveBeenCalled();
    });

    it("accepts keys over HTTP at the discovery document's origin, or when OIDC_JWKS_URI replaces them", async () => {
        const sameOrigin = {
            ...DOCUMENT,
            jwks_uri: "http://authentik:9000/application/o/eudiplo/jwks/",
        };
        const elsewhere = {
            ...DOCUMENT,
            jwks_uri: "http://keys.example.com/jwks",
        };

        await expect(
            new OidcIssuerMetadataLoader(policy(sameOrigin)).load({
                issuer: ISSUER,
                internalIssuer: INTERNAL,
            }),
        ).resolves.toMatchObject({ jwks_uri: sameOrigin.jwks_uri });
        await expect(
            new OidcIssuerMetadataLoader(policy(elsewhere)).load({
                issuer: ISSUER,
                internalIssuer: INTERNAL,
                jwksUri: "http://authentik:9000/jwks/",
            }),
        ).resolves.toMatchObject({ issuer: ISSUER });
    });

    it("retries a response that is no JSON, such as a proxy page while the provider starts", async () => {
        const time = clock();
        const outbound = policy(DOCUMENT);
        outbound.get = vi
            .fn()
            .mockResolvedValueOnce({
                status: 200,
                body: "<html>starting</html>",
            })
            .mockResolvedValueOnce({
                status: 200,
                body: JSON.stringify(DOCUMENT),
            });

        const metadata = await new OidcIssuerMetadataLoader(outbound).load({
            issuer: ISSUER,
            internalIssuer: INTERNAL,
            ...time,
        });

        expect(metadata.issuer).toBe(ISSUER);
        expect(time.sleep).toHaveBeenCalledOnce();
    });

    it("does not follow redirects, so the document comes from the configured URL", async () => {
        const time = clock();
        const outbound = policy(302, 302);

        await expect(
            new OidcIssuerMetadataLoader(outbound).load({
                issuer: ISSUER,
                internalIssuer: INTERNAL,
                retryMs: 1_000,
                ...time,
            }),
        ).rejects.toThrow("status code 302");
        expect(outbound.calls.map(([url]) => url)).toEqual([
            "http://authentik:9000/application/o/eudiplo/.well-known/openid-configuration",
            "http://authentik:9000/application/o/eudiplo/.well-known/openid-configuration",
        ]);
    });
});
