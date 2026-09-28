import { describe, expect, it, vi } from "vitest";
import { SessionNotFound } from "../../../../session/application/session-errors.js";
import { CorrelateCredentialTokenSession } from "./correlate-credential-token-session.js";

function fixture(boundSession: Record<string, unknown> = {}) {
    const sources = {
        tokenIssuers: vi.fn().mockResolvedValue({
            localIssuer: "local",
            chainedIssuer: "chained",
            hasChainedAuthorizationServer: true,
            managedAuthorizationServerIssuers: new Set(["managed"]),
        }),
        externalServer: vi.fn().mockResolvedValue({
            advertised: true,
            configuration: { id: "external-as", bindingClaim: "binding" },
        }),
    };
    const sessions = {
        getForTenant: vi.fn().mockResolvedValue({
            id: "session",
            tenantId: "tenant",
            authorizationServerId: "external-as",
            externalIssuer: "external",
            externalSubject: "user",
            ...boundSession,
        }),
    };
    return {
        sources,
        sessions,
        useCase: new CorrelateCredentialTokenSession(sources, sessions),
    };
}

const external = { iss: "external", sub: "user", binding: "session" };

describe("CorrelateCredentialTokenSession.execute", () => {
    it("uses the local token subject as session id", async () => {
        const f = fixture();
        expect(
            await f.useCase.execute("tenant", { iss: "local", sub: "session" }),
        ).toEqual({ kind: "local", sessionId: "session" });
        expect(f.sources.tokenIssuers).toHaveBeenCalledWith("tenant");
    });

    it("uses issuer_state for chained and managed tokens", async () => {
        const f = fixture();
        expect(
            await f.useCase.execute("tenant", {
                iss: "chained",
                sub: "x",
                issuer_state: "session",
            }),
        ).toEqual({
            kind: "chained",
            sessionId: "session",
            viaChainedIssuer: true,
        });
        expect(
            await f.useCase.execute("tenant", {
                iss: "managed",
                sub: "x",
                issuer_state: "session",
            }),
        ).toEqual({
            kind: "chained",
            sessionId: "session",
            viaChainedIssuer: false,
        });
        await expect(
            f.useCase.execute("tenant", { iss: "chained", sub: "x" }),
        ).rejects.toThrow("missing issuer_state");
    });

    it("uses the configured binding claim for external tokens without binding", async () => {
        const f = fixture();
        expect(await f.useCase.execute("tenant", external)).toEqual({
            kind: "external",
            sessionId: "session",
            authorizationServerId: "external-as",
            bindingClaim: "binding",
        });
        expect(f.sources.externalServer).toHaveBeenCalledWith(
            "tenant",
            "external",
        );
        expect(f.sessions.getForTenant).not.toHaveBeenCalled();
    });
});

describe("CorrelateCredentialTokenSession.belongsToSession", () => {
    it.each([
        [{ iss: "local", sub: "session" }],
        [{ iss: "chained", sub: "x", issuer_state: "session" }],
        [external],
    ])("accepts a token of the session %j", async (token) => {
        const f = fixture();
        expect(
            await f.useCase.belongsToSession("tenant", token, "session"),
        ).toBe(true);
    });

    it.each([
        [{ iss: "local", sub: "other" }],
        [{ iss: "chained", sub: "session", issuer_state: "other" }],
        [{ iss: "chained", sub: "session" }],
        [{ ...external, binding: "other" }],
        [{ iss: "external", sub: "user" }],
    ])("rejects a token of another session %j", async (token) => {
        const f = fixture();
        expect(
            await f.useCase.belongsToSession("tenant", token, "session"),
        ).toBe(false);
    });

    it("loads external sessions within the tenant", async () => {
        const f = fixture();
        await f.useCase.belongsToSession("tenant", external, "session");
        expect(f.sessions.getForTenant).toHaveBeenCalledWith(
            "tenant",
            "session",
        );
    });

    it.each([
        { externalSubject: "someone-else" },
        { externalIssuer: "other-issuer" },
        { authorizationServerId: "other-as" },
        { externalIssuer: undefined, externalSubject: undefined },
    ])(
        "rejects an external token not bound to the session %j",
        async (bound) => {
            const f = fixture(bound);
            expect(
                await f.useCase.belongsToSession("tenant", external, "session"),
            ).toBe(false);
        },
    );

    it("rejects an external token whose session no longer exists", async () => {
        const f = fixture();
        f.sessions.getForTenant.mockRejectedValue(new SessionNotFound());
        expect(
            await f.useCase.belongsToSession("tenant", external, "session"),
        ).toBe(false);
    });
});
