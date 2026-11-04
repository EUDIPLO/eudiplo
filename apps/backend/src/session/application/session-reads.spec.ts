import { describe, expect, it, vi } from "vitest";
import { Role } from "../../auth/roles/role.enum.js";
import { SessionReads } from "./session-reads.js";
import type { SessionStore } from "./session-store.js";

function reads() {
    const sessions = {
        listForTenant: vi.fn().mockResolvedValue({ items: [] }),
        statsForTenant: vi.fn().mockResolvedValue({ issuance: { total: 2 } }),
    };
    const retention = {
        forTenant: vi
            .fn()
            .mockResolvedValue({ ttlSeconds: 3600, cleanupMode: "full" }),
    };
    return {
        sessions,
        retention,
        reads: new SessionReads(sessions as unknown as SessionStore, retention),
    };
}

describe("SessionReads", () => {
    it.each([
        [[Role.IssuanceOffer], "issuance", []],
        [[Role.PresentationRequest], "presentation", []],
        [[Role.SessionsRead], undefined, ["issuance", "presentation"]],
        [[Role.SessionsRead, Role.IssuanceOffer], undefined, ["presentation"]],
    ])(
        "lists the sessions a caller with %j may read",
        async (roles, scope, hideOpen) => {
            const { reads: subject, sessions } = reads();
            const query = { page: 1, pageSize: 25 };

            await subject.list("tenant-1", { roles }, query);

            expect(sessions.listForTenant).toHaveBeenCalledWith(
                "tenant-1",
                { ...query, hideOpen },
                scope,
            );
        },
    );

    it("lets the caller's roles decide what is hidden, not the query", async () => {
        const { reads: subject, sessions } = reads();

        await subject.list(
            "tenant-1",
            { roles: [Role.SessionsRead] },
            { page: 1, pageSize: 25, hideOpen: [] },
        );

        expect(sessions.listForTenant.mock.calls[0][1].hideOpen).toEqual([
            "issuance",
            "presentation",
        ]);
    });

    it("counts the caller's session types of the tenant and adds its retention", async () => {
        const { reads: subject, sessions, retention } = reads();
        const filter = { createdFrom: new Date(0) };

        await expect(
            subject.stats("tenant-1", { roles: [Role.IssuanceOffer] }, filter),
        ).resolves.toEqual({
            issuance: { total: 2 },
            retention: { ttlSeconds: 3600, cleanupMode: "full" },
        });
        expect(sessions.statsForTenant).toHaveBeenCalledWith(
            "tenant-1",
            "issuance",
            filter,
        );
        expect(retention.forTenant).toHaveBeenCalledWith("tenant-1");
    });

    it("refuses a caller without a session role", async () => {
        const { reads: subject } = reads();
        expect(() =>
            subject.list(
                "tenant-1",
                { roles: [Role.Keys] },
                {
                    page: 1,
                    pageSize: 25,
                },
            ),
        ).toThrow("Token has no role that grants access to sessions");
    });
});
