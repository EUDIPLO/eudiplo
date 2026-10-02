import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionCleanupMode } from "../domain/session-retention.js";
import type { SessionRepository } from "../ports/session.repository.js";
import type { SessionRetentionPolicies } from "../ports/session-retention-policies.js";
import { CleanupSessions } from "./cleanup-sessions.js";

function setup() {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-01T12:00:00Z"));
    const sessions = {
        findExpiredSessionsForMaintenance: vi
            .fn<SessionRepository["findExpiredSessionsForMaintenance"]>()
            .mockResolvedValue([]),
        deleteSessionsCreatedBefore: vi
            .fn<SessionRepository["deleteSessionsCreatedBefore"]>()
            .mockResolvedValue(0),
        anonymizeSessionsCreatedBefore: vi
            .fn<SessionRepository["anonymizeSessionsCreatedBefore"]>()
            .mockResolvedValue(0),
        deleteOrphanedSessionsCreatedBefore: vi
            .fn<SessionRepository["deleteOrphanedSessionsCreatedBefore"]>()
            .mockResolvedValue(0),
    };
    const policies = {
        listForMaintenance: vi
            .fn<SessionRetentionPolicies["listForMaintenance"]>()
            .mockResolvedValue([]),
    };
    const changeState = { executeFrom: vi.fn().mockResolvedValue(true) };
    const cleanup = new CleanupSessions(sessions, policies, changeState, {
        ttlSeconds: 3600,
        cleanupMode: SessionCleanupMode.Full,
    });
    return { sessions, policies, changeState, cleanup };
}

describe("CleanupSessions", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("expires overdue presentations and unredeemed issuance offers alike", async () => {
        const { sessions, changeState, cleanup } = setup();
        const presentation = {
            id: "presentation",
            tenantId: "tenant",
            requestId: "config",
        };
        const offer = { id: "offer", tenantId: "tenant", requestId: null };
        sessions.findExpiredSessionsForMaintenance.mockResolvedValue([
            presentation,
            offer,
        ]);
        changeState.executeFrom.mockResolvedValueOnce(true);
        // The second one completed after the selection: nothing to announce.
        changeState.executeFrom.mockResolvedValueOnce(false);
        await cleanup.execute();
        expect(changeState.executeFrom.mock.calls).toEqual([
            [presentation, ["active", "fetched"], "expired"],
            [offer, ["active", "fetched"], "expired"],
        ]);
    });

    it("finishes expiry state changes before fetching retention policies and deleting data", async () => {
        const { sessions, policies, changeState, cleanup } = setup();
        const session = {
            id: "expired",
            tenantId: "tenant",
            requestId: "presentation",
        };
        sessions.findExpiredSessionsForMaintenance.mockResolvedValue([session]);
        let finish!: () => void;
        changeState.executeFrom.mockReturnValue(
            new Promise<boolean>((resolve) => {
                finish = () => resolve(true);
            }),
        );
        const pending = cleanup.execute();
        await Promise.resolve();
        // Only still-open sessions expire; a finished one keeps its state.
        expect(changeState.executeFrom).toHaveBeenCalledWith(
            session,
            ["active", "fetched"],
            "expired",
        );
        expect(policies.listForMaintenance).not.toHaveBeenCalled();
        finish();
        await pending;
        expect(policies.listForMaintenance).toHaveBeenCalledOnce();
        expect(sessions.findExpiredSessionsForMaintenance).toHaveBeenCalledWith(
            new Date("2026-02-01T12:00:00Z"),
        );
    });

    it("inherits defaults per field, applies tenant overrides, then uses default TTL for orphans", async () => {
        const { sessions, policies, cleanup } = setup();
        policies.listForMaintenance.mockResolvedValue([
            { tenantId: "default" },
            {
                tenantId: "anonymize",
                ttlSeconds: 120,
                cleanupMode: SessionCleanupMode.Anonymize,
            },
            { tenantId: "ttl-only", ttlSeconds: 600 },
            {
                tenantId: "mode-only",
                cleanupMode: SessionCleanupMode.Anonymize,
            },
            { tenantId: "nulls", ttlSeconds: null, cleanupMode: null },
        ]);
        await cleanup.execute();
        expect(sessions.deleteSessionsCreatedBefore.mock.calls).toEqual([
            ["default", new Date("2026-02-01T11:00:00Z")],
            ["ttl-only", new Date("2026-02-01T11:50:00Z")],
            ["nulls", new Date("2026-02-01T11:00:00Z")],
        ]);
        expect(sessions.anonymizeSessionsCreatedBefore.mock.calls).toEqual([
            ["anonymize", new Date("2026-02-01T11:58:00Z")],
            ["mode-only", new Date("2026-02-01T11:00:00Z")],
        ]);
        expect(
            sessions.deleteOrphanedSessionsCreatedBefore,
        ).toHaveBeenCalledWith(
            ["default", "anonymize", "ttl-only", "mode-only", "nulls"],
            new Date("2026-02-01T11:00:00Z"),
        );
    });

    it("skips all retention deletes when no tenants exist, but still checks expiry", async () => {
        const { sessions, cleanup } = setup();
        await cleanup.execute();
        expect(
            sessions.findExpiredSessionsForMaintenance,
        ).toHaveBeenCalledOnce();
        expect(sessions.deleteSessionsCreatedBefore).not.toHaveBeenCalled();
        expect(sessions.anonymizeSessionsCreatedBefore).not.toHaveBeenCalled();
        expect(
            sessions.deleteOrphanedSessionsCreatedBefore,
        ).not.toHaveBeenCalled();
    });

    it("reloads tenant overrides on every run", async () => {
        const { sessions, policies, cleanup } = setup();
        policies.listForMaintenance
            .mockResolvedValueOnce([{ tenantId: "a" }])
            .mockResolvedValueOnce([
                { tenantId: "a", cleanupMode: SessionCleanupMode.Anonymize },
            ]);
        await cleanup.execute();
        await cleanup.execute();
        expect(sessions.deleteSessionsCreatedBefore).toHaveBeenCalledOnce();
        expect(sessions.anonymizeSessionsCreatedBefore).toHaveBeenCalledOnce();
    });

    it("does not proceed to retention if an expiry state change fails", async () => {
        const { sessions, policies, changeState, cleanup } = setup();
        const error = new Error("write failed");
        sessions.findExpiredSessionsForMaintenance.mockResolvedValue([
            { id: "id", tenantId: "a" },
        ]);
        changeState.executeFrom.mockRejectedValue(error);
        await expect(cleanup.execute()).rejects.toBe(error);
        expect(policies.listForMaintenance).not.toHaveBeenCalled();
        expect(
            sessions.deleteOrphanedSessionsCreatedBefore,
        ).not.toHaveBeenCalled();
    });

    it("stops after a tenant cleanup failure without deleting orphaned sessions", async () => {
        const { sessions, policies, cleanup } = setup();
        policies.listForMaintenance.mockResolvedValue([
            { tenantId: "a" },
            { tenantId: "b" },
        ]);
        const error = new Error("delete failed");
        sessions.deleteSessionsCreatedBefore.mockRejectedValue(error);
        await expect(cleanup.execute()).rejects.toBe(error);
        expect(sessions.deleteSessionsCreatedBefore).toHaveBeenCalledOnce();
        expect(
            sessions.deleteOrphanedSessionsCreatedBefore,
        ).not.toHaveBeenCalled();
    });
});
