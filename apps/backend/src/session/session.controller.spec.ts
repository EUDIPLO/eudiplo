import { ConflictException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { rolesAllow } from "../../test/roles-guard.js";
import { Role } from "../auth/roles/role.enum.js";
import type { TokenPayload } from "../auth/token.decorator.js";
import type { StatusListService } from "../issuer/status-list/status-list.service.js";
import {
    type CancelSession,
    SessionNotCancellable,
} from "./application/cancel-session.js";
import { SessionNotFound } from "./application/session-errors.js";
import type { SessionStore } from "./application/session-store.js";
import { SessionStatus } from "./domain/session-state.js";
import type { SessionLogStoreService } from "./logging/session-log-store.service.js";
import { SessionController } from "./session.controller.js";

function createController() {
    const sessions = {
        listForTenant: vi.fn().mockResolvedValue({ items: [] }),
        statsForTenant: vi.fn().mockResolvedValue({}),
        getForTenant: vi.fn().mockResolvedValue({ id: "session-1" }),
        deleteForTenant: vi.fn().mockResolvedValue(undefined),
    };
    const logs = { findBySessionId: vi.fn().mockResolvedValue([]) };
    const cancel = { execute: vi.fn().mockResolvedValue(undefined) };
    const statusList = { getSessionStatus: vi.fn().mockResolvedValue([]) };
    const controller = new SessionController(
        sessions as unknown as SessionStore,
        statusList as unknown as StatusListService,
        logs as unknown as SessionLogStoreService,
        cancel as unknown as CancelSession,
    );
    return { controller, sessions, logs, cancel, statusList };
}

const token = (roles: Role[]) =>
    ({ entity: { id: "tenant-1" }, roles }) as unknown as TokenPayload;

const query = { page: 1, pageSize: 25 };

describe("SessionController", () => {
    describe("role checks", () => {
        it.each([
            [[Role.IssuanceOffer], true],
            [[Role.Issuances], true],
            [[Role.PresentationRequest], false],
            [[Role.PresentationRequest, Role.Presentations], false],
        ])(
            "lets a client with %j read and change credential status: %s",
            (roles, allowed) => {
                expect(rolesAllow(SessionController, "revokeAll", roles)).toBe(
                    allowed,
                );
                expect(
                    rolesAllow(SessionController, "getCredentialStatus", roles),
                ).toBe(allowed);
            },
        );

        it.each([
            "getAllSessions",
            "getSessionStats",
            "getSession",
            "deleteSession",
            "getSessionLogs",
            "cancel",
        ] as const)(
            "%s needs issuance:offer or presentation:request",
            (handler) => {
                const allows = (roles: Role[]) =>
                    rolesAllow(SessionController, handler, roles);
                expect(allows([Role.IssuanceOffer])).toBe(true);
                expect(allows([Role.PresentationRequest])).toBe(true);
                expect(allows([Role.Issuances])).toBe(false);
                expect(allows([Role.Presentations])).toBe(false);
            },
        );
    });

    describe("session scope", () => {
        it.each([
            [[Role.PresentationRequest], "presentation"],
            [[Role.IssuanceOffer], "issuance"],
            [[Role.IssuanceOffer, Role.PresentationRequest], undefined],
        ])("limits a client with %j to %s sessions", async (roles, scope) => {
            const { controller, sessions, logs } = createController();
            const caller = token(roles);

            await controller.getAllSessions(caller, query);
            await controller.getSessionStats(caller);
            await controller.getSession("session-1", caller);
            await controller.deleteSession("session-1", caller);
            await controller.getSessionLogs("session-1", caller);

            expect(sessions.listForTenant).toHaveBeenCalledExactlyOnceWith(
                "tenant-1",
                query,
                scope,
            );
            expect(sessions.statsForTenant).toHaveBeenCalledExactlyOnceWith(
                "tenant-1",
                scope,
            );
            expect(sessions.getForTenant).toHaveBeenCalledTimes(2);
            for (const call of sessions.getForTenant.mock.calls) {
                expect(call).toEqual(["tenant-1", "session-1", scope]);
            }
            expect(sessions.deleteForTenant).toHaveBeenCalledExactlyOnceWith(
                "tenant-1",
                "session-1",
                scope,
            );
            expect(logs.findBySessionId).toHaveBeenCalledWith("session-1");
        });

        it("returns no logs of a session outside the scope", async () => {
            const { controller, sessions, logs } = createController();
            sessions.getForTenant.mockRejectedValue(new SessionNotFound());

            await expect(
                controller.getSessionLogs(
                    "session-1",
                    token([Role.PresentationRequest]),
                ),
            ).rejects.toBeInstanceOf(SessionNotFound);
            expect(logs.findBySessionId).not.toHaveBeenCalled();
        });
    });

    describe("credential status", () => {
        it("reads the status of a session in the caller's scope", async () => {
            const { controller, sessions, statusList } = createController();
            const entry = {
                credentialConfigurationId: "pid",
                statusListId: "list-1",
                index: 3,
                status: 1,
                bits: 1,
            };
            statusList.getSessionStatus.mockResolvedValue([entry]);

            await expect(
                controller.getCredentialStatus(
                    "session-1",
                    token([Role.Issuances]),
                ),
            ).resolves.toEqual([entry]);
            expect(sessions.getForTenant).toHaveBeenCalledExactlyOnceWith(
                "tenant-1",
                "session-1",
                "issuance",
            );
            expect(statusList.getSessionStatus).toHaveBeenCalledWith(
                "tenant-1",
                "session-1",
            );
        });

        it("reads no status of a session outside the scope", async () => {
            const { controller, sessions, statusList } = createController();
            sessions.getForTenant.mockRejectedValue(new SessionNotFound());

            await expect(
                controller.getCredentialStatus(
                    "session-1",
                    token([Role.IssuanceOffer]),
                ),
            ).rejects.toBeInstanceOf(SessionNotFound);
            expect(statusList.getSessionStatus).not.toHaveBeenCalled();
        });
    });

    describe("cancel", () => {
        it("cancels within the caller's scope and records the client as actor", async () => {
            const { controller, cancel } = createController();
            const caller = {
                ...token([Role.IssuanceOffer]),
                client: { clientId: "client-1" },
            } as unknown as TokenPayload;

            await controller.cancel(
                "session-1",
                { reason: "sent to wrong recipient" },
                caller,
                { requestId: "request-1" },
            );

            expect(cancel.execute).toHaveBeenCalledExactlyOnceWith({
                tenantId: "tenant-1",
                sessionId: "session-1",
                scope: "issuance",
                reason: "sent to wrong recipient",
                actor: { type: "client", id: "client-1", display: "client-1" },
                requestMeta: { requestId: "request-1" },
            });
        });

        it("answers a session that is no longer open with 409", async () => {
            const { controller, cancel } = createController();
            cancel.execute.mockRejectedValue(
                new SessionNotCancellable(SessionStatus.Completed),
            );

            await expect(
                controller.cancel(
                    "session-1",
                    {},
                    token([Role.IssuanceOffer]),
                    {},
                ),
            ).rejects.toBeInstanceOf(ConflictException);
        });

        it("passes a missing session on as SessionNotFound (404)", async () => {
            const { controller, cancel } = createController();
            cancel.execute.mockRejectedValue(new SessionNotFound());

            await expect(
                controller.cancel(
                    "session-1",
                    {},
                    token([Role.IssuanceOffer]),
                    {},
                ),
            ).rejects.toBeInstanceOf(SessionNotFound);
        });
    });
});
