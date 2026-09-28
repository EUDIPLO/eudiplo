import { describe, expect, it, vi } from "vitest";
import {
    ExternalSessionBindingError,
    ResolveExternalAuthorizationSession,
} from "./resolve-external-authorization-session.js";

describe("ResolveExternalAuthorizationSession", () => {
    it.each([
        [undefined, "claim", "id"],
        ["server", undefined, "id"],
        ["server", "claim", undefined],
        ["", "claim", "id"],
    ])(
        "requires server, claim and value before persistence",
        async (server, claim, value) => {
            const sessions = { bindExternalAuthorization: vi.fn() };
            await expect(
                new ResolveExternalAuthorizationSession(sessions).execute(
                    "tenant",
                    "issuer",
                    "subject",
                    server,
                    claim,
                    value,
                ),
            ).rejects.toBeInstanceOf(ExternalSessionBindingError);
            expect(sessions.bindExternalAuthorization).not.toHaveBeenCalled();
        },
    );
    it("returns the adapter snapshot with explicit binding scope", async () => {
        const snapshot = { id: "id", externalSubject: "previous" };
        const sessions = {
            bindExternalAuthorization: vi.fn().mockResolvedValue(snapshot),
        };
        expect(
            await new ResolveExternalAuthorizationSession(sessions).execute(
                "tenant",
                "issuer",
                "subject",
                "server",
                "claim",
                "id",
            ),
        ).toBe(snapshot);
        expect(
            sessions.bindExternalAuthorization,
        ).toHaveBeenCalledExactlyOnceWith({
            tenantId: "tenant",
            externalIssuer: "issuer",
            externalSubject: "subject",
            authorizationServerId: "server",
            sessionId: "id",
        });
    });
    it("preserves the missing-session message and propagates storage failures", async () => {
        const sessions = {
            bindExternalAuthorization: vi.fn().mockResolvedValue(null),
        };
        const useCase = new ResolveExternalAuthorizationSession(sessions);
        await expect(
            useCase.execute(
                "tenant",
                "issuer",
                "subject",
                "server",
                "claim",
                "id",
            ),
        ).rejects.toThrow(
            "No existing issuance session found for external AS token for tenant tenant, auth server server, claim claim, value id",
        );
        const failure = new Error("storage unavailable");
        sessions.bindExternalAuthorization.mockRejectedValue(failure);
        await expect(
            useCase.execute(
                "tenant",
                "issuer",
                "subject",
                "server",
                "claim",
                "id",
            ),
        ).rejects.toBe(failure);
    });
});
