import { describe, expect, it, vi } from "vitest";
import { ResolveCredentialSession } from "./resolve-credential-session.js";

function fixture() {
    const session = { id: "session", tenantId: "tenant" };
    const sources = {
        tokenIssuers: vi.fn().mockResolvedValue({
            localIssuer: "local",
            chainedIssuer: "chained",
            hasChainedAuthorizationServer: true,
            managedAuthorizationServerIssuers: new Set(["managed"]),
        }),
        externalServer: vi.fn().mockResolvedValue({
            advertised: true,
            configuration: { id: "external", bindingClaim: "binding" },
        }),
        upstreamIdentity: vi.fn().mockResolvedValue({
            iss: "upstream",
            sub: "user",
            token_claims: {},
        }),
    };
    const sessions = { execute: vi.fn().mockResolvedValue(session) };
    const external = { execute: vi.fn().mockResolvedValue(session) };
    const claims = {
        resolveClaims: vi
            .fn()
            .mockResolvedValue({ deferred: false, claims: {} }),
    };
    return {
        session,
        sources,
        sessions,
        external,
        claims,
        useCase: new ResolveCredentialSession(
            sources,
            sessions,
            external,
            claims,
        ),
    };
}

describe("ResolveCredentialSession", () => {
    it("resolves local token subjects within their tenant", async () => {
        const f = fixture();
        expect(
            await f.useCase.execute("tenant", "pid", {
                iss: "local",
                sub: "session",
            }),
        ).toMatchObject({
            session: f.session,
            isExternalAsToken: false,
            isChainedAsToken: false,
        });
        expect(f.sessions.execute).toHaveBeenCalledWith("tenant", "session");
        expect(f.external.execute).not.toHaveBeenCalled();
        expect(f.claims.resolveClaims).toHaveBeenCalledWith(
            expect.objectContaining({
                session: f.session,
                credentialConfigurationId: "pid",
                identity: {
                    iss: "local",
                    sub: "session",
                    token_claims: { iss: "local", sub: "session" },
                },
            }),
        );
    });
    it("rejects a local token for a different returned session", async () => {
        const f = fixture();
        await expect(
            f.useCase.execute("tenant", "pid", { iss: "local", sub: "wrong" }),
        ).rejects.toMatchObject({
            name: "CredentialSessionAuthorizationDenied",
        });
        expect(f.claims.resolveClaims).not.toHaveBeenCalled();
    });
    it("uses the upstream identity for chained tokens", async () => {
        const f = fixture();
        await f.useCase.execute("tenant", "pid", {
            iss: "chained",
            sub: "token-sub",
            issuer_state: "session",
        });
        expect(f.sources.upstreamIdentity).toHaveBeenCalledWith("session");
        expect(f.claims.resolveClaims).toHaveBeenCalledWith(
            expect.objectContaining({
                identity: { iss: "upstream", sub: "user", token_claims: {} },
            }),
        );
    });
    it("uses managed token identity without legacy chained lookup", async () => {
        const f = fixture();
        await f.useCase.execute("tenant", "pid", {
            iss: "managed",
            sub: "token-sub",
            upstream_sub: "user",
            issuer_state: "session",
        });
        expect(f.sources.upstreamIdentity).not.toHaveBeenCalled();
        expect(f.claims.resolveClaims).toHaveBeenCalledWith(
            expect.objectContaining({
                identity: expect.objectContaining({
                    iss: "managed",
                    sub: "user",
                }),
            }),
        );
    });
    it("requires issuer_state before looking up a chained session", async () => {
        const f = fixture();
        await expect(
            f.useCase.execute("tenant", "pid", {
                iss: "chained",
                sub: "session",
            }),
        ).rejects.toThrow("missing issuer_state");
        expect(f.sessions.execute).not.toHaveBeenCalled();
    });
    it("binds external identities and requires a claims provider", async () => {
        const f = fixture();
        await f.useCase.execute("tenant", "pid", {
            iss: "external",
            sub: "user",
            binding: "correlation",
        });
        expect(f.external.execute).toHaveBeenCalledWith(
            "tenant",
            "external",
            "user",
            "external",
            "binding",
            "correlation",
        );
        expect(f.claims.resolveClaims).toHaveBeenCalledWith(
            expect.objectContaining({ requireProvider: true }),
        );
    });
    it.each([
        { advertised: false },
        { advertised: true },
        { advertised: true, configuration: { id: "external" } },
    ])("rejects unavailable external bindings %j", async (result) => {
        const f = fixture();
        f.sources.externalServer.mockResolvedValue(result);
        await expect(
            f.useCase.execute("tenant", "pid", {
                iss: "external",
                sub: "user",
            }),
        ).rejects.toMatchObject({
            name: "CredentialSessionAuthorizationDenied",
        });
        expect(f.external.execute).not.toHaveBeenCalled();
        expect(f.claims.resolveClaims).not.toHaveBeenCalled();
    });
});
