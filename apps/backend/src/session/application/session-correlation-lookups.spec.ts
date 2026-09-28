import { describe, expect, it, vi } from "vitest";
import type { SessionData } from "../domain/session-data.js";
import { GetIso18013Session } from "./get-iso18013-session.js";
import { GetSessionForInternalFlow } from "./get-session-for-internal-flow.js";
import { GetSessionForWalletRequest } from "./get-session-for-wallet-request.js";
import { SessionNotFound } from "./session-errors.js";

describe("session correlation lookup use cases", () => {
    const session = { id: "session-1", tenantId: "tenant-1" } as SessionData;

    it("resolves wallet nonce using the repository's compatible lookup", async () => {
        const findForWalletRequest = vi.fn().mockResolvedValue(session);
        const useCase = new GetSessionForWalletRequest({
            findForWalletRequest,
        });

        await expect(useCase.execute("wallet-nonce")).resolves.toBe(session);
        expect(findForWalletRequest).toHaveBeenCalledExactlyOnceWith(
            "wallet-nonce",
        );
    });

    it("resolves internal correlation by session ID", async () => {
        const findByIdForInternalFlow = vi.fn().mockResolvedValue(session);
        const useCase = new GetSessionForInternalFlow({
            findByIdForInternalFlow,
        });

        await expect(useCase.execute("session-1")).resolves.toBe(session);
        expect(findByIdForInternalFlow).toHaveBeenCalledExactlyOnceWith(
            "session-1",
        );
    });

    it("resolves only ISO 18013 sessions", async () => {
        const findIso18013Session = vi.fn().mockResolvedValue(session);
        const useCase = new GetIso18013Session({ findIso18013Session });

        await expect(useCase.execute("session-1")).resolves.toBe(session);
        expect(findIso18013Session).toHaveBeenCalledExactlyOnceWith(
            "session-1",
        );
    });

    it("maps missing correlation records to the application error", async () => {
        const useCase = new GetSessionForWalletRequest({
            findForWalletRequest: vi.fn().mockResolvedValue(null),
        });

        await expect(useCase.execute("unknown-nonce")).rejects.toBeInstanceOf(
            SessionNotFound,
        );
    });
});
