import { describe, expect, test } from "vitest";
import {
    hashClientSecret,
    matchClientSecret,
    type OidcClientSecret,
    redirectUriProblem,
    scopesProblem,
    secretUseIsStale,
} from "./oidc-client.js";

describe("redirectUriProblem", () => {
    test.each([
        "https://rp.example.com/callback",
        "https://rp.example.com/callback?tenant=a",
        "http://localhost:3000/callback",
        "http://127.0.0.1/cb",
        "http://[::1]:8080/cb",
    ])("accepts %s", (uri) => {
        expect(redirectUriProblem(uri)).toBeUndefined();
    });

    test.each([
        ["http://rp.example.com/callback", "HTTPS"],
        ["https://rp.example.com/callback#fragment", "fragment"],
        ["https://user:pass@rp.example.com/cb", "user information"],
        ["/relative", "absolute"],
        ["javascript:alert(1)", "HTTPS"],
    ])("refuses %s", (uri, reason) => {
        expect(redirectUriProblem(uri)).toContain(reason);
    });
});

describe("scopesProblem", () => {
    test("accepts distinct scopes and configs", () => {
        expect(
            scopesProblem([
                { scope: "pid", presentationConfigId: "pid" },
                { scope: "age_over_18", presentationConfigId: "age" },
            ]),
        ).toBeUndefined();
    });

    test("refuses openid, bad names and duplicates", () => {
        expect(
            scopesProblem([{ scope: "openid", presentationConfigId: "pid" }]),
        ).toContain("reserved");
        expect(
            scopesProblem([{ scope: "two words", presentationConfigId: "a" }]),
        ).toContain("must match");
        expect(
            scopesProblem([
                { scope: "pid", presentationConfigId: "a" },
                { scope: "pid", presentationConfigId: "b" },
            ]),
        ).toContain("twice");
        expect(
            scopesProblem([
                { scope: "a", presentationConfigId: "pid" },
                { scope: "b", presentationConfigId: "pid" },
            ]),
        ).toContain("more than one scope");
    });
});

describe("matchClientSecret", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const secret = (
        id: string,
        value: string,
        expiresAt?: Date,
    ): OidcClientSecret => ({
        id,
        hash: hashClientSecret(value),
        createdAt: now,
        expiresAt,
    });

    test("finds either of two secrets", () => {
        const client = {
            secrets: [secret("old", "first"), secret("new", "second")],
        };
        expect(matchClientSecret(client, "first", now)?.id).toBe("old");
        expect(matchClientSecret(client, "second", now)?.id).toBe("new");
        expect(matchClientSecret(client, "third", now)).toBeUndefined();
    });

    test("refuses an expired secret", () => {
        const client = { secrets: [secret("old", "first", now)] };
        expect(matchClientSecret(client, "first", now)).toBeUndefined();
    });
});

test("secretUseIsStale writes lastUsedAt at most every five minutes", () => {
    const now = new Date("2026-01-01T00:10:00Z");
    const base = { id: "s", hash: "h", createdAt: now };
    expect(secretUseIsStale(base, now)).toBe(true);
    expect(
        secretUseIsStale(
            { ...base, lastUsedAt: new Date("2026-01-01T00:08:00Z") },
            now,
        ),
    ).toBe(false);
    expect(
        secretUseIsStale(
            { ...base, lastUsedAt: new Date("2026-01-01T00:05:00Z") },
            now,
        ),
    ).toBe(true);
});
