import { describe, expect, it, vi } from "vitest";
import type { SessionData } from "../domain/session-data.js";
import { GetSessionByAuthorizationCode } from "./get-session-by-authorization-code.js";
import { GetSessionByRefreshToken } from "./get-session-by-refresh-token.js";
import { GetSessionByRequestUri } from "./get-session-by-request-uri.js";
import { SessionNotFound } from "./session-errors.js";

describe("authorization session lookup use cases", () => {
    const session = { id: "session-1", tenantId: "tenant-1" } as SessionData;

    it("resolves PAR request URIs within their tenant", async () => {
        const findByRequestUri = vi.fn().mockResolvedValue(session);
        const useCase = new GetSessionByRequestUri({ findByRequestUri });

        await expect(
            useCase.execute("tenant-1", "urn:request:1"),
        ).resolves.toBe(session);
        expect(findByRequestUri).toHaveBeenCalledExactlyOnceWith(
            "tenant-1",
            "urn:request:1",
        );
    });

    it("resolves authorization codes within their tenant", async () => {
        const findByAuthorizationCode = vi.fn().mockResolvedValue(session);
        const useCase = new GetSessionByAuthorizationCode({
            findByAuthorizationCode,
        });

        await expect(useCase.execute("tenant-1", "code-1")).resolves.toBe(
            session,
        );
        expect(findByAuthorizationCode).toHaveBeenCalledExactlyOnceWith(
            "tenant-1",
            "code-1",
        );
    });

    it("does not query when the authorization code is absent", async () => {
        const findByAuthorizationCode = vi.fn();
        const useCase = new GetSessionByAuthorizationCode({
            findByAuthorizationCode,
        });

        await expect(
            useCase.execute("tenant-1", undefined),
        ).rejects.toBeInstanceOf(SessionNotFound);
        expect(findByAuthorizationCode).not.toHaveBeenCalled();
    });

    it("resolves refresh tokens within their tenant", async () => {
        const findByRefreshToken = vi.fn().mockResolvedValue(session);
        const useCase = new GetSessionByRefreshToken({ findByRefreshToken });

        await expect(useCase.execute("tenant-1", "refresh-1")).resolves.toBe(
            session,
        );
        expect(findByRefreshToken).toHaveBeenCalledExactlyOnceWith(
            "tenant-1",
            "refresh-1",
        );
    });

    it("maps missing records and preserves persistence failures", async () => {
        const findByRefreshToken = vi.fn().mockResolvedValue(null);
        const useCase = new GetSessionByRefreshToken({ findByRefreshToken });
        await expect(
            useCase.execute("tenant-1", "refresh-1"),
        ).rejects.toBeInstanceOf(SessionNotFound);

        const failure = new Error("database unavailable");
        findByRefreshToken.mockRejectedValue(failure);
        await expect(useCase.execute("tenant-1", "refresh-1")).rejects.toBe(
            failure,
        );
    });
});
