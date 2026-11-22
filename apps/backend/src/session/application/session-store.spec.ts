import { describe, expect, it, vi } from "vitest";
import type { SessionData } from "../domain/session-data.js";
import { SessionStatus } from "../domain/session-state.js";
import type { SessionRepository } from "../ports/session.repository.js";
import { SessionNotFound } from "./session-errors.js";
import { SessionStore } from "./session-store.js";

const session = { id: "session-1", tenantId: "tenant-1" } as SessionData;

function createStore(
    overrides: Partial<SessionRepository> = {},
    context = { bind: vi.fn() },
) {
    const repository = {
        findForTenant: vi.fn().mockResolvedValue(session),
        findByIdForInternalFlow: vi.fn().mockResolvedValue(session),
        findForWalletRequest: vi.fn().mockResolvedValue(session),
        findIssuanceForWalletReference: vi.fn().mockResolvedValue(session),
        findIso18013Session: vi.fn().mockResolvedValue(session),
        findByAuthorizationCode: vi.fn().mockResolvedValue(session),
        findByRefreshToken: vi.fn().mockResolvedValue(session),
        findByRequestUri: vi.fn().mockResolvedValue(session),
        updateForTenant: vi.fn().mockResolvedValue(1),
        updateUnconsumedForTenant: vi.fn().mockResolvedValue(true),
        consumeRequestUri: vi.fn().mockResolvedValue(true),
        listForTenant: vi.fn(),
        countForTenant: vi.fn().mockResolvedValue([]),
        topFailureCodesForTenant: vi.fn().mockResolvedValue([]),
        lastUpdatedForTenant: vi.fn().mockResolvedValue(null),
        deleteForTenant: vi.fn().mockResolvedValue(undefined),
        findCredentialOffer: vi.fn(),
        consumeCredentialOffer: vi.fn(),
        ...overrides,
    };
    return {
        store: new SessionStore(repository, context),
        repository,
        context,
    };
}

describe("SessionStore", () => {
    it.each([
        [
            "getForTenant",
            "findForTenant",
            ["tenant-1", "session-1", "presentation"],
        ],
        [
            "getByAuthorizationCode",
            "findByAuthorizationCode",
            ["tenant-1", "code-1"],
        ],
        ["getByRefreshToken", "findByRefreshToken", ["tenant-1", "refresh-1"]],
        ["getByRequestUri", "findByRequestUri", ["tenant-1", "urn:request:1"]],
        ["getForWalletRequest", "findForWalletRequest", ["nonce-1"]],
        [
            "getIssuanceForWalletReference",
            "findIssuanceForWalletReference",
            ["tenant-1", "nonce-1"],
        ],
        ["getForInternalFlow", "findByIdForInternalFlow", ["session-1"]],
        ["getIso18013", "findIso18013Session", ["nonce-1"]],
    ] as const)(
        "%s passes its scope through, binds the session and maps a miss to SessionNotFound",
        async (method, finder, args) => {
            const { store, repository, context } = createStore();
            const call = () =>
                (store[method] as (...a: string[]) => unknown)(...args);

            await expect(call()).resolves.toBe(session);
            expect(repository[finder]).toHaveBeenCalledExactlyOnceWith(...args);
            expect(context.bind).toHaveBeenCalledExactlyOnceWith(session);

            vi.mocked(repository[finder]).mockResolvedValue(null);
            await expect(call()).rejects.toBeInstanceOf(SessionNotFound);
            expect(context.bind).toHaveBeenCalledOnce();
        },
    );

    it.each([undefined, ""])(
        "rejects an absent wallet reference (%j) without querying",
        async (reference) => {
            const { store, repository } = createStore();

            await expect(
                store.getIssuanceForWalletReference("tenant-1", reference),
            ).rejects.toBeInstanceOf(SessionNotFound);
            expect(
                repository.findIssuanceForWalletReference,
            ).not.toHaveBeenCalled();
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

    it("binds the session of a found credential offer only", async () => {
        const { store, repository, context } = createStore({
            findCredentialOffer: vi
                .fn()
                .mockResolvedValueOnce({
                    id: "session-1",
                    offer: null,
                    status: "active",
                })
                .mockResolvedValueOnce(null),
        });

        // Found by wallet reference, bound by the session ID.
        await store.findCredentialOffer("tenant-1", "nonce-1");
        await store.findCredentialOffer("tenant-1", "nonce-2");

        expect(repository.findCredentialOffer).toHaveBeenCalledTimes(2);
        expect(context.bind).toHaveBeenCalledExactlyOnceWith({
            id: "session-1",
            tenantId: "tenant-1",
        });
    });

    it.each([
        [SessionStatus.Active, false, ["issuance"], false],
        [SessionStatus.Fetched, false, ["issuance"], false],
        [SessionStatus.Active, true, ["issuance"], true],
        [SessionStatus.Completed, false, ["issuance"], true],
        [SessionStatus.Active, false, ["presentation"], true],
        [SessionStatus.Active, false, [], true],
    ] as const)(
        "getForReader finds a %s issuance session with consumed %s and hideOpen %j: %s",
        async (status, consumed, hideOpen, found) => {
            const { store, repository } = createStore({
                findForTenant: vi
                    .fn()
                    .mockResolvedValue({ ...session, status, consumed }),
            });

            const read = store.getForReader(
                "tenant-1",
                "session-1",
                "issuance",
                hideOpen,
            );

            if (found) await expect(read).resolves.toMatchObject({ status });
            else await expect(read).rejects.toBeInstanceOf(SessionNotFound);
            expect(repository.findForTenant).toHaveBeenCalledWith(
                "tenant-1",
                "session-1",
                "issuance",
            );
        },
    );

    it("getForReader hides an open presentation session by its requestId", async () => {
        const { store } = createStore({
            findForTenant: vi.fn().mockResolvedValue({
                ...session,
                requestId: "age-check",
                status: SessionStatus.Fetched,
                consumed: false,
            }),
        });

        await expect(
            store.getForReader("tenant-1", "session-1", undefined, [
                "presentation",
            ]),
        ).rejects.toBeInstanceOf(SessionNotFound);
        await expect(
            store.getForReader("tenant-1", "session-1", undefined, [
                "issuance",
            ]),
        ).resolves.toMatchObject({ requestId: "age-check" });
    });

    it("reads a session of another configuration than the caller's limits as missing", async () => {
        const { store, context } = createStore({
            findForTenant: vi
                .fn()
                .mockResolvedValue({ ...session, requestId: "mdl" }),
        });

        await expect(
            store.getForTenant("tenant-1", "session-1", undefined, {
                presentation: ["pid"],
            }),
        ).rejects.toBeInstanceOf(SessionNotFound);
        await expect(
            store.getForReader("tenant-1", "session-1", undefined, [], {
                presentation: ["pid"],
            }),
        ).rejects.toBeInstanceOf(SessionNotFound);
        expect(context.bind).not.toHaveBeenCalled();
        await expect(
            store.getForTenant("tenant-1", "session-1", undefined, {
                presentation: ["pid", "mdl"],
            }),
        ).resolves.toMatchObject({ requestId: "mdl" });
    });

    it("deletes no session of another configuration than the caller's limits", async () => {
        const { store, repository } = createStore({
            findForTenant: vi
                .fn()
                .mockResolvedValue({ ...session, requestId: "mdl" }),
        });

        await store.deleteForTenant("tenant-1", "session-1", "presentation", {
            presentation: ["pid"],
        });
        expect(repository.deleteForTenant).not.toHaveBeenCalled();

        await store.deleteForTenant("tenant-1", "session-1", "presentation", {
            presentation: ["mdl"],
        });
        expect(repository.deleteForTenant).toHaveBeenCalledExactlyOnceWith(
            "tenant-1",
            "session-1",
            "presentation",
        );
    });

    it.each([
        ["a missing session", null],
        [
            "an offer that includes another configuration",
            { ...session, credentialConfigurationIds: ["pid", "mdl"] },
        ],
        ["an issuance session without stored configurations", session],
    ])("deletes nothing for %s under an issuance limit", async (_, found) => {
        const { store, repository } = createStore({
            findForTenant: vi.fn().mockResolvedValue(found),
        });

        await store.deleteForTenant("tenant-1", "session-1", "issuance", {
            issuance: ["pid"],
        });

        expect(repository.deleteForTenant).not.toHaveBeenCalled();
    });

    it("deletes without reading first for a caller without limits", async () => {
        const { store, repository } = createStore();

        await store.deleteForTenant("tenant-1", "session-1", undefined, {
            presentation: [],
        });

        expect(repository.findForTenant).not.toHaveBeenCalled();
        expect(repository.deleteForTenant).toHaveBeenCalledOnce();
    });

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
        await store.deleteForTenant("tenant-1", "session-1", "issuance");
        expect(repository.deleteForTenant).toHaveBeenCalledWith(
            "tenant-1",
            "session-1",
            "issuance",
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

    it.each([
        [undefined, undefined, undefined],
        [undefined, "issuance", "issuance"],
        ["presentation", undefined, "presentation"],
        ["presentation", "presentation", "presentation"],
    ] as const)(
        "lists sessions of scope %s with type filter %s as type %s",
        async (scope, type, expected) => {
            const { store, repository } = createStore({
                listForTenant: vi
                    .fn()
                    .mockResolvedValue({ items: [], total: 0 }),
            });

            await store.listForTenant(
                "tenant-a",
                { page: 1, pageSize: 25, type },
                scope,
            );

            expect(repository.listForTenant).toHaveBeenCalledExactlyOnceWith(
                "tenant-a",
                { page: 1, pageSize: 25, type: expected },
            );
        },
    );

    it("lists nothing for a type filter outside the scope, without querying", async () => {
        const { store, repository } = createStore();

        await expect(
            store.listForTenant(
                "tenant-a",
                { page: 1, pageSize: 25, type: "issuance" },
                "presentation",
            ),
        ).resolves.toEqual({
            items: [],
            total: 0,
            page: 1,
            pageSize: 25,
            totalPages: 0,
        });
        expect(repository.listForTenant).not.toHaveBeenCalled();
    });

    it("counts both types for an unscoped caller", async () => {
        const lastPresentation = new Date("2026-10-10T08:00:00Z");
        const { store, repository } = createStore({
            countForTenant: vi.fn().mockResolvedValue([
                { type: "issuance", status: SessionStatus.Active, count: 2 },
                {
                    type: "presentation",
                    status: SessionStatus.Failed,
                    count: 4,
                },
            ]),
            topFailureCodesForTenant: vi.fn(async (_tenant, { type }) =>
                type === "presentation"
                    ? [{ code: "invalid_proof", count: 4 }]
                    : [],
            ),
            lastUpdatedForTenant: vi.fn(async (_tenant, { type }) =>
                type === "presentation" ? lastPresentation : null,
            ),
        });

        const stats = await store.statsForTenant("tenant-a");

        expect(stats.issuance).toMatchObject({
            total: 2,
            byStatus: { active: 2, failed: 0 },
            failureCodes: [],
            lastCompletedAt: null,
        });
        expect(stats.presentation).toMatchObject({
            total: 4,
            byStatus: { active: 0, failed: 4 },
            failureCodes: [{ code: "invalid_proof", count: 4 }],
            lastCompletedAt: lastPresentation,
        });
        expect(repository.countForTenant).toHaveBeenCalledExactlyOnceWith(
            "tenant-a",
            { type: undefined },
        );
        for (const type of ["issuance", "presentation"])
            expect(repository.lastUpdatedForTenant).toHaveBeenCalledWith(
                "tenant-a",
                { type, status: SessionStatus.Completed },
            );
    });

    it("counts only the scoped type, within the creation time range", async () => {
        const { store, repository } = createStore();
        const range = {
            createdFrom: new Date("2026-10-10T00:00:00Z"),
            createdTo: new Date("2026-10-10T23:59:59Z"),
        };

        const stats = await store.statsForTenant(
            "tenant-a",
            "presentation",
            range,
        );

        expect(Object.keys(stats)).toEqual(["presentation"]);
        const scoped = { ...range, type: "presentation" };
        expect(repository.countForTenant).toHaveBeenCalledExactlyOnceWith(
            "tenant-a",
            scoped,
        );
        expect(
            repository.topFailureCodesForTenant,
        ).toHaveBeenCalledExactlyOnceWith("tenant-a", scoped, 10);
        expect(repository.lastUpdatedForTenant).toHaveBeenCalledExactlyOnceWith(
            "tenant-a",
            { ...scoped, status: SessionStatus.Completed },
        );
    });

    it("counts only the sessions within the caller's limits", async () => {
        const { store, repository } = createStore();
        const configLimits = { presentation: ["pid"] };

        await store.statsForTenant(
            "tenant-a",
            "presentation",
            {},
            configLimits,
        );

        const scoped = { configLimits, type: "presentation" };
        expect(repository.countForTenant).toHaveBeenCalledExactlyOnceWith(
            "tenant-a",
            scoped,
        );
        expect(
            repository.topFailureCodesForTenant,
        ).toHaveBeenCalledExactlyOnceWith("tenant-a", scoped, 10);
        expect(repository.lastUpdatedForTenant).toHaveBeenCalledExactlyOnceWith(
            "tenant-a",
            { ...scoped, status: SessionStatus.Completed },
        );
    });
});
