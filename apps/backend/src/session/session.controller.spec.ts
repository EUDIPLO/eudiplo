import { ConflictException, RequestMethod } from "@nestjs/common";
import { METHOD_METADATA } from "@nestjs/common/constants.js";
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
import { SessionReads } from "./application/session-reads.js";
import type { SessionStore } from "./application/session-store.js";
import { SessionStatus } from "./domain/session-state.js";
import type { SessionLogStoreService } from "./logging/session-log-store.service.js";
import { SessionController } from "./session.controller.js";

function createController() {
    const sessions = {
        listForTenant: vi.fn().mockResolvedValue({ items: [] }),
        statsForTenant: vi.fn().mockResolvedValue({}),
        getForReader: vi.fn().mockResolvedValue({ id: "session-1" }),
        deleteForTenant: vi.fn().mockResolvedValue(undefined),
    };
    const logs = { findBySessionId: vi.fn().mockResolvedValue([]) };
    const cancel = { execute: vi.fn().mockResolvedValue(undefined) };
    const statusList = { getSessionStatus: vi.fn().mockResolvedValue([]) };
    const sessionConfig = {
        getEffectiveConfig: vi
            .fn()
            .mockResolvedValue({ ttlSeconds: 86400, cleanupMode: "full" }),
    };
    const controller = new SessionController(
        sessions as unknown as SessionStore,
        statusList as unknown as StatusListService,
        logs as unknown as SessionLogStoreService,
        cancel as unknown as CancelSession,
        new SessionReads(sessions as unknown as SessionStore, {
            forTenant: (tenantId) => sessionConfig.getEffectiveConfig(tenantId),
        }),
    );
    return { controller, sessions, logs, cancel, statusList, sessionConfig };
}

const token = (roles: Role[]) =>
    ({ entity: { id: "tenant-1" }, roles }) as unknown as TokenPayload;

const query = { page: 1, pageSize: 25 };

const WRITE_METHODS = new Set([
    RequestMethod.POST,
    RequestMethod.PUT,
    RequestMethod.PATCH,
    RequestMethod.DELETE,
]);

describe("SessionController", () => {
    describe("role checks", () => {
        it.each([
            [[Role.CredentialStatus], true],
            [[Role.Issuances], true],
            [[Role.IssuanceOffer], false],
            [[Role.SessionsRead], false],
            [[Role.PresentationRequest, Role.Presentations], false],
        ])(
            "lets a client with %j change credential status: %s",
            (roles, allowed) => {
                expect(rolesAllow(SessionController, "revokeAll", roles)).toBe(
                    allowed,
                );
            },
        );

        it.each([
            [[Role.IssuanceOffer], true],
            [[Role.Issuances], true],
            [[Role.CredentialStatus], true],
            [[Role.SessionsRead], true],
            [[Role.PresentationRequest], false],
            [[Role.PresentationRequest, Role.Presentations], false],
        ])(
            "lets a client with %j read credential status: %s",
            (roles, allowed) => {
                expect(
                    rolesAllow(SessionController, "getCredentialStatus", roles),
                ).toBe(allowed);
            },
        );

        it.each([
            "getAllSessions",
            "getSessionStats",
            "getSession",
            "getSessionLogs",
        ] as const)(
            "%s needs issuance:offer, presentation:request or sessions:read",
            (handler) => {
                const allows = (roles: Role[]) =>
                    rolesAllow(SessionController, handler, roles);
                expect(allows([Role.IssuanceOffer])).toBe(true);
                expect(allows([Role.PresentationRequest])).toBe(true);
                expect(allows([Role.SessionsRead])).toBe(true);
                expect(allows([Role.Issuances])).toBe(false);
                expect(allows([Role.Presentations])).toBe(false);
                expect(allows([Role.CredentialStatus])).toBe(false);
            },
        );

        it("lets sessions:read call no route that changes sessions", () => {
            const writes = Object.getOwnPropertyNames(
                SessionController.prototype,
            ).filter((name) =>
                WRITE_METHODS.has(
                    Reflect.getMetadata(
                        METHOD_METADATA,
                        SessionController.prototype[
                            name as keyof SessionController
                        ],
                    ),
                ),
            ) as (keyof SessionController & string)[];

            expect(writes.sort()).toEqual(
                ["cancel", "deleteSession", "revokeAll"].sort(),
            );
            for (const handler of writes) {
                expect(
                    rolesAllow(SessionController, handler, [Role.SessionsRead]),
                ).toBe(false);
            }
        });

        it.each(["deleteSession", "cancel"] as const)(
            "%s needs issuance:offer or presentation:request",
            (handler) => {
                const allows = (roles: Role[]) =>
                    rolesAllow(SessionController, handler, roles);
                expect(allows([Role.IssuanceOffer])).toBe(true);
                expect(allows([Role.PresentationRequest])).toBe(true);
                expect(allows([Role.SessionsRead])).toBe(false);
                expect(allows([Role.CredentialStatus])).toBe(false);
                expect(allows([Role.Issuances])).toBe(false);
                expect(allows([Role.Presentations])).toBe(false);
            },
        );
    });

    describe("session scope", () => {
        it.each([
            [[Role.PresentationRequest], "presentation", []],
            [[Role.IssuanceOffer], "issuance", []],
            [[Role.IssuanceOffer, Role.PresentationRequest], undefined, []],
        ])(
            "limits a client with %j to %s sessions",
            async (roles, scope, hideOpen) => {
                const { controller, sessions, logs } = createController();
                const caller = token(roles);

                await controller.getAllSessions(caller, query);
                await controller.getSessionStats(caller, {});
                await controller.getSession("session-1", caller);
                await controller.deleteSession("session-1", caller);
                await controller.getSessionLogs("session-1", caller);

                expect(sessions.listForTenant).toHaveBeenCalledExactlyOnceWith(
                    "tenant-1",
                    { ...query, hideOpen },
                    scope,
                );
                expect(sessions.statsForTenant).toHaveBeenCalledExactlyOnceWith(
                    "tenant-1",
                    scope,
                    {},
                );
                expect(sessions.getForReader).toHaveBeenCalledTimes(2);
                for (const call of sessions.getForReader.mock.calls) {
                    expect(call).toEqual([
                        "tenant-1",
                        "session-1",
                        scope,
                        hideOpen,
                    ]);
                }
                expect(
                    sessions.deleteForTenant,
                ).toHaveBeenCalledExactlyOnceWith(
                    "tenant-1",
                    "session-1",
                    scope,
                );
                expect(logs.findBySessionId).toHaveBeenCalledWith("session-1");
            },
        );

        it("reads both session types with sessions:read but changes only its side", async () => {
            const { controller, sessions, cancel } = createController();
            const caller = token([Role.SessionsRead, Role.PresentationRequest]);

            await controller.getAllSessions(caller, query);
            await controller.getSessionStats(caller, {});
            await controller.getSession("session-1", caller);
            await controller.getSessionLogs("session-1", caller);
            await controller.deleteSession("session-1", caller);
            await controller.cancel("session-1", {}, caller, {});

            // Open issuance sessions stay hidden: it may only read them.
            expect(sessions.listForTenant).toHaveBeenCalledWith(
                "tenant-1",
                { ...query, hideOpen: ["issuance"] },
                undefined,
            );
            expect(sessions.statsForTenant).toHaveBeenCalledWith(
                "tenant-1",
                undefined,
                {},
            );
            expect(sessions.getForReader).toHaveBeenCalledTimes(2);
            for (const call of sessions.getForReader.mock.calls) {
                expect(call).toEqual([
                    "tenant-1",
                    "session-1",
                    undefined,
                    ["issuance"],
                ]);
            }
            expect(sessions.deleteForTenant).toHaveBeenCalledExactlyOnceWith(
                "tenant-1",
                "session-1",
                "presentation",
            );
            expect(cancel.execute).toHaveBeenCalledWith(
                expect.objectContaining({ scope: "presentation" }),
            );
        });

        it.each([
            [[Role.SessionsRead], {}, false],
            [[Role.SessionsRead], { requestId: "age-check" }, false],
            [[Role.SessionsRead, Role.IssuanceOffer], {}, true],
            [
                [Role.SessionsRead, Role.IssuanceOffer],
                { requestId: "pid" },
                false,
            ],
            [[Role.PresentationRequest], { requestId: "pid" }, true],
            [[Role.SessionsRead, Role.CredentialStatus], {}, false],
            [[Role.SessionsRead, Role.Issuances], {}, false],
            [
                [Role.SessionsRead, Role.Presentations],
                { requestId: "pid" },
                false,
            ],
        ])(
            "gives a client with %j the bearer values of the session %j: %s",
            async (roles, fields, full) => {
                const { controller, sessions } = createController();
                sessions.getForReader.mockResolvedValue({
                    id: "session-1",
                    ...fields,
                    offerUrl: "openid-credential-offer://…",
                    requestUrl: "openid4vp://…",
                    credentialPayload: { tx_code: "1234" },
                });

                const session = await controller.getSession(
                    "session-1",
                    token(roles),
                );

                expect(session.offerUrl !== undefined).toBe(full);
                expect(session.requestUrl !== undefined).toBe(full);
                expect(session.credentialPayload?.tx_code !== undefined).toBe(
                    full,
                );
            },
        );

        it("returns no logs of a session outside the scope", async () => {
            const { controller, sessions, logs } = createController();
            sessions.getForReader.mockRejectedValue(new SessionNotFound());

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
            expect(sessions.getForReader).toHaveBeenCalledExactlyOnceWith(
                "tenant-1",
                "session-1",
                "issuance",
                [],
            );
            expect(statusList.getSessionStatus).toHaveBeenCalledWith(
                "tenant-1",
                "session-1",
            );
        });

        it.each([
            [[Role.CredentialStatus], "issuance", []],
            [[Role.CredentialStatus, Role.PresentationRequest], undefined, []],
            [[Role.SessionsRead], undefined, ["issuance", "presentation"]],
        ])(
            "reads the status with %j within %s sessions",
            async (roles, scope, hideOpen) => {
                const { controller, sessions } = createController();

                await controller.getCredentialStatus("session-1", token(roles));

                expect(sessions.getForReader).toHaveBeenCalledExactlyOnceWith(
                    "tenant-1",
                    "session-1",
                    scope,
                    hideOpen,
                );
            },
        );

        it("reads no status of a session outside the scope", async () => {
            const { controller, sessions, statusList } = createController();
            sessions.getForReader.mockRejectedValue(new SessionNotFound());

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

    describe("stats", () => {
        it("reports the tenant's effective retention with the counts", async () => {
            const { controller, sessions, sessionConfig } = createController();
            sessions.statsForTenant.mockResolvedValue({ presentation: {} });

            await expect(
                controller.getSessionStats(
                    token([Role.PresentationRequest]),
                    {},
                ),
            ).resolves.toEqual({
                presentation: {},
                retention: { ttlSeconds: 86400, cleanupMode: "full" },
            });
            expect(sessionConfig.getEffectiveConfig).toHaveBeenCalledWith(
                "tenant-1",
            );
        });
    });
});
