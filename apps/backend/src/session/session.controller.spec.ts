import { type ExecutionContext, ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { describe, expect, it, vi } from "vitest";
import { Role } from "../auth/roles/role.enum.js";
import { RolesGuard } from "../auth/roles/roles.guard.js";
import type { TokenPayload } from "../auth/token.decorator.js";
import type { StatusListService } from "../issuer/status-list/status-list.service.js";
import { SessionNotFound } from "./application/session-errors.js";
import type { SessionStore } from "./application/session-store.js";
import type { SessionLogStoreService } from "./logging/session-log-store.service.js";
import { SessionController } from "./session.controller.js";

type Handler =
    | "getAllSessions"
    | "getSession"
    | "deleteSession"
    | "getSessionLogs"
    | "revokeAll";

/** Runs the same role check the `@Secured` guard runs for the handler. */
function allows(handler: Handler, roles: Role[]): boolean {
    const context = {
        getHandler: () => SessionController.prototype[handler],
        getClass: () => SessionController,
        switchToHttp: () => ({ getRequest: () => ({ user: { roles } }) }),
    } as unknown as ExecutionContext;
    return new RolesGuard(new Reflector()).canActivate(context);
}

function createController() {
    const sessions = {
        listForTenant: vi.fn().mockResolvedValue({ items: [] }),
        getForTenant: vi.fn().mockResolvedValue({ id: "session-1" }),
        deleteForTenant: vi.fn().mockResolvedValue(undefined),
    };
    const logs = { findBySessionId: vi.fn().mockResolvedValue([]) };
    const controller = new SessionController(
        sessions as unknown as SessionStore,
        {} as StatusListService,
        logs as unknown as SessionLogStoreService,
    );
    return { controller, sessions, logs };
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
            "lets a client with %j change credential status: %s",
            (roles, allowed) => {
                expect(allows("revokeAll", roles)).toBe(allowed);
            },
        );

        it.each([
            "getAllSessions",
            "getSession",
            "deleteSession",
            "getSessionLogs",
        ] as const)(
            "%s needs issuance:offer or presentation:request",
            (handler) => {
                expect(allows(handler, [Role.IssuanceOffer])).toBe(true);
                expect(allows(handler, [Role.PresentationRequest])).toBe(true);
                expect(allows(handler, [Role.Issuances])).toBe(false);
                expect(allows(handler, [Role.Presentations])).toBe(false);
            },
        );
    });

    describe("session scope", () => {
        it.each([
            [[Role.PresentationRequest], "presentation"],
            [[Role.PresentationRequest, Role.Presentations], "presentation"],
            [[Role.IssuanceOffer], "issuance"],
            [[Role.IssuanceOffer, Role.Issuances], "issuance"],
            [[Role.IssuanceOffer, Role.PresentationRequest], undefined],
            [[Role.IssuanceOffer, Role.Presentations], undefined],
            [[Role.PresentationRequest, Role.Issuances], undefined],
        ])("limits a client with %j to %s sessions", async (roles, scope) => {
            const { controller, sessions, logs } = createController();
            const caller = token(roles);

            await controller.getAllSessions(caller, query);
            await controller.getSession("session-1", caller);
            await controller.deleteSession("session-1", caller);
            await controller.getSessionLogs("session-1", caller);

            expect(sessions.listForTenant).toHaveBeenCalledExactlyOnceWith(
                "tenant-1",
                query,
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

        it("rejects a token without a session role instead of widening the scope", () => {
            const { controller, sessions } = createController();

            expect(() =>
                controller.getAllSessions(token([Role.Clients]), query),
            ).toThrow(ForbiddenException);
            expect(sessions.listForTenant).not.toHaveBeenCalled();
        });
    });
});
