import { describe, expect, it, vi } from "vitest";
import type { SessionData } from "../domain/session-data.js";
import type { SessionRepository } from "../ports/session.repository.js";
import { SessionNotFound } from "./session-errors.js";
import { SessionStore } from "./session-store.js";

const session = { id: "session-1", tenantId: "tenant-1" } as SessionData;

function createStore(overrides: Partial<SessionRepository> = {}) {
    const repository = {
        findForTenant: vi.fn().mockResolvedValue(session),
        findByIdForInternalFlow: vi.fn().mockResolvedValue(session),
        findForWalletRequest: vi.fn().mockResolvedValue(session),
        findIso18013Session: vi.fn().mockResolvedValue(session),
        findByAuthorizationCode: vi.fn().mockResolvedValue(session),
        findByRefreshToken: vi.fn().mockResolvedValue(session),
        findByRequestUri: vi.fn().mockResolvedValue(session),
        updateForTenant: vi.fn().mockResolvedValue(1),
        updateUnconsumedForTenant: vi.fn().mockResolvedValue(true),
        consumeRequestUri: vi.fn().mockResolvedValue(true),
        listForTenant: vi.fn(),
        deleteForTenant: vi.fn().mockResolvedValue(undefined),
        findCredentialOffer: vi.fn(),
        consumeCredentialOffer: vi.fn(),
        ...overrides,
    };
    return { store: new SessionStore(repository), repository };
}

describe("SessionStore", () => {
    it.each([
        ["getForTenant", "findForTenant", ["tenant-1", "session-1"]],
        [
            "getByAuthorizationCode",
            "findByAuthorizationCode",
            ["tenant-1", "code-1"],
        ],
        ["getByRefreshToken", "findByRefreshToken", ["tenant-1", "refresh-1"]],
        ["getByRequestUri", "findByRequestUri", ["tenant-1", "urn:request:1"]],
        ["getForWalletRequest", "findForWalletRequest", ["nonce-1"]],
        ["getForInternalFlow", "findByIdForInternalFlow", ["session-1"]],
        ["getIso18013", "findIso18013Session", ["session-1"]],
    ] as const)(
        "%s passes its scope through and maps a miss to SessionNotFound",
        async (method, finder, args) => {
            const { store, repository } = createStore();
            const call = () =>
                (store[method] as (...a: string[]) => unknown)(...args);

            await expect(call()).resolves.toBe(session);
            expect(repository[finder]).toHaveBeenCalledExactlyOnceWith(...args);

            vi.mocked(repository[finder]).mockResolvedValue(null);
            await expect(call()).rejects.toBeInstanceOf(SessionNotFound);
        },
    );

    it.each([undefined, ""])(
        "rejects an absent authorization code (%j) without querying",
        async (code) => {
            const { store, repository } = createStore();

            await expect(
                store.getByAuthorizationCode("tenant-1", code),
            ).rejects.toBeInstanceOf(SessionNotFound);
            expect(repository.findByAuthorizationCode).not.toHaveBeenCalled();
        },
    );

    it("rejects an absent session ID without querying", async () => {
        const { store, repository } = createStore();

        await expect(
            store.getForTenant("tenant-1", undefined),
        ).rejects.toBeInstanceOf(SessionNotFound);
        expect(repository.findForTenant).not.toHaveBeenCalled();
    });

    it("propagates persistence failures unchanged", async () => {
        const failure = new Error("database unavailable");
        const { store } = createStore({
            findByRefreshToken: vi.fn().mockRejectedValue(failure),
        });

        await expect(
            store.getByRefreshToken("tenant-1", "refresh-1"),
        ).rejects.toBe(failure);
    });

    it("forwards tenant-scoped writes and returns their results", async () => {
        const { store, repository } = createStore();
        const update = { requestObject: "request" };

        await expect(
            store.updateForTenant("tenant-1", "session-1", update),
        ).resolves.toBe(1);
        expect(repository.updateForTenant).toHaveBeenCalledWith(
            "tenant-1",
            "session-1",
            update,
        );
        await expect(
            store.updateIfUnconsumed("tenant-1", "session-1", update),
        ).resolves.toBe(true);
        expect(repository.updateUnconsumedForTenant).toHaveBeenCalledWith(
            "tenant-1",
            "session-1",
            update,
        );
        const expiresAt = new Date("2026-01-01T12:01:00.000Z");
        const now = new Date("2026-01-01T12:00:00.000Z");
        await expect(
            store.consumeRequestUri("tenant-1", "session-1", expiresAt, now),
        ).resolves.toBe(true);
        expect(repository.consumeRequestUri).toHaveBeenCalledWith(
            "tenant-1",
            "session-1",
            expiresAt,
            now,
        );
        await store.deleteForTenant("tenant-1", "session-1");
        expect(repository.deleteForTenant).toHaveBeenCalledWith(
            "tenant-1",
            "session-1",
        );
    });

    it.each([
        [0, 0],
        [25, 1],
        [26, 2],
    ])("computes pages for %i matching sessions", async (total, totalPages) => {
        const { store, repository } = createStore({
            listForTenant: vi.fn().mockResolvedValue({ items: [], total }),
        });
        const query = { page: 2, pageSize: 25 };

        await expect(store.listForTenant("tenant-a", query)).resolves.toEqual({
            items: [],
            total,
            page: 2,
            pageSize: 25,
            totalPages,
        });
        expect(repository.listForTenant).toHaveBeenCalledWith(
            "tenant-a",
            query,
        );
    });
});
