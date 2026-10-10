import { describe, expect, it } from "vitest";
import {
    assertApiKeyKeptOnlyForSameUrl,
    assertUpstreamSecretsKeptOnlyForSameIssuer,
    REDACTED_SECRET,
    redactSecrets,
    restoreSecrets,
    SecretNotStoredError,
    SecretTargetChangedError,
} from "./write-only-secrets.util.js";

const auth = (value: string) => ({
    type: "apiKey",
    config: { headerName: "X-Key", value },
});
const chained = (id: string, clientSecret?: string) => ({
    type: "chained",
    id,
    upstream: { issuer: "https://idp.example", clientId: "c", clientSecret },
});

describe("redactSecrets", () => {
    it("replaces the secrets at the paths and copies the input", () => {
        const endpoint = { id: "e", auth: auth("key") };

        expect(redactSecrets(endpoint, "auth.config.value")).toEqual({
            id: "e",
            auth: auth(REDACTED_SECRET),
        });
        expect(endpoint.auth.config.value).toBe("key");
    });

    it("leaves values without a secret alone", () => {
        expect(
            redactSecrets(
                {
                    authorizationServers: [
                        { type: "built-in", id: "b" },
                        chained("c"),
                    ],
                },
                "authorizationServers.*.upstream.clientSecret",
            ),
        ).toEqual({
            authorizationServers: [{ type: "built-in", id: "b" }, chained("c")],
        });
        expect(
            redactSecrets({ auth: { type: "none" } }, "auth.config.value"),
        ).toEqual({ auth: { type: "none" } });
    });
});

describe("restoreSecrets", () => {
    it("keeps the stored secret when the marker is sent back", () => {
        expect(
            restoreSecrets(
                { auth: auth(REDACTED_SECRET) },
                { auth: auth("stored") },
                "auth.config.value",
            ),
        ).toEqual({ auth: auth("stored") });
    });

    it("takes a new secret as sent", () => {
        expect(
            restoreSecrets(
                { auth: auth("new") },
                { auth: auth("stored") },
                "auth.config.value",
            ),
        ).toEqual({ auth: auth("new") });
    });

    it("pairs array items by id and type, not by position", () => {
        const stored = {
            authorizationServers: [
                chained("first", "first-secret"),
                chained("second", "second-secret"),
            ],
        };

        expect(
            restoreSecrets(
                {
                    authorizationServers: [
                        chained("second", REDACTED_SECRET),
                        chained("first", REDACTED_SECRET),
                    ],
                },
                stored,
                "authorizationServers.*.upstream.clientSecret",
            ),
        ).toEqual({
            authorizationServers: [
                chained("second", "second-secret"),
                chained("first", "first-secret"),
            ],
        });
    });

    it.each([
        ["nothing is stored", undefined],
        ["the stored entry has no secret", { auth: { type: "none" } }],
    ])("rejects the marker when %s", (_case, stored) => {
        expect(() =>
            restoreSecrets(
                { auth: auth(REDACTED_SECRET) },
                stored,
                "auth.config.value",
            ),
        ).toThrow(SecretNotStoredError);
    });

    it("rejects the marker for a server whose id is new", () => {
        expect(() =>
            restoreSecrets(
                { authorizationServers: [chained("new", REDACTED_SECRET)] },
                { authorizationServers: [chained("old", "secret")] },
                "authorizationServers.*.upstream.clientSecret",
            ),
        ).toThrow(
            "authorizationServers[0].upstream.clientSecret is '<redacted>'",
        );
    });
});

describe("assertApiKeyKeptOnlyForSameUrl", () => {
    const stored = { url: "https://old.example", auth: auth("stored") };

    it.each([
        ["sends the marker", { auth: auth(REDACTED_SECRET) }],
        ["omits auth", {}],
    ])("rejects a new URL when the update %s", (_case, update) => {
        expect(() =>
            assertApiKeyKeptOnlyForSameUrl(
                { url: "https://new.example", ...update },
                stored,
            ),
        ).toThrow(SecretTargetChangedError);
    });

    it.each([
        ["a new URL with a new key", "https://new.example", auth("new")],
        [
            "the same URL with the marker",
            "https://old.example",
            auth(REDACTED_SECRET),
        ],
        [
            "a new URL without authentication",
            "https://new.example",
            { type: "none" },
        ],
    ])("accepts %s", (_case, url, newAuth) => {
        expect(() =>
            assertApiKeyKeptOnlyForSameUrl({ url, auth: newAuth }, stored),
        ).not.toThrow();
    });
});

describe("assertUpstreamSecretsKeptOnlyForSameIssuer", () => {
    const stored = [chained("c", "stored")];

    it("rejects the marker for a server whose upstream issuer changes", () => {
        const moved = chained("c", REDACTED_SECRET);
        moved.upstream.issuer = "https://other-idp.example";

        expect(() =>
            assertUpstreamSecretsKeptOnlyForSameIssuer([moved], stored),
        ).toThrow(SecretTargetChangedError);
    });

    it("accepts the marker for the same issuer and a new secret for a new issuer", () => {
        const moved = chained("c", "new-secret");
        moved.upstream.issuer = "https://other-idp.example";

        expect(() =>
            assertUpstreamSecretsKeptOnlyForSameIssuer(
                [chained("c", REDACTED_SECRET)],
                stored,
            ),
        ).not.toThrow();
        expect(() =>
            assertUpstreamSecretsKeptOnlyForSameIssuer([moved], stored),
        ).not.toThrow();
    });
});
