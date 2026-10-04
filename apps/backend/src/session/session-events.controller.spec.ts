import { describe, expect, it, vi } from "vitest";
import { rolesAllow } from "../../test/roles-guard.js";
import { Role } from "../auth/roles/role.enum.js";
import type { TokenPayload } from "../auth/token.decorator.js";
import { SessionNotFound } from "./application/session-errors.js";
import type { SessionStore } from "./application/session-store.js";
import { SessionEventsController } from "./session-events.controller.js";
import type { SessionEventsService } from "./session-events.service.js";

function createController() {
    const sessions = {
        getForTenant: vi.fn().mockResolvedValue({ id: "session-1" }),
    };
    const stream = Symbol("stream");
    const events = { getSessionEvents: vi.fn().mockReturnValue(stream) };
    const controller = new SessionEventsController(
        events as unknown as SessionEventsService,
        sessions as unknown as SessionStore,
    );
    return { controller, sessions, events, stream };
}

const token = (roles: Role[]) =>
    ({ entity: { id: "tenant-1" }, roles }) as unknown as TokenPayload;

describe("SessionEventsController", () => {
    it("needs issuance:offer or presentation:request, like reading the session", () => {
        const allows = (roles: Role[]) =>
            rolesAllow(
                SessionEventsController,
                "subscribeToSessionEvents",
                roles,
            );
        expect(allows([Role.IssuanceOffer])).toBe(true);
        expect(allows([Role.PresentationRequest])).toBe(true);
        expect(allows([Role.Issuances])).toBe(false);
        expect(allows([Role.Clients])).toBe(false);
        expect(allows([])).toBe(false);
    });

    it.each([
        [[Role.PresentationRequest], "presentation"],
        [[Role.IssuanceOffer], "issuance"],
        [[Role.IssuanceOffer, Role.PresentationRequest], undefined],
    ])(
        "streams only sessions a client with %j may read (%s)",
        async (roles, scope) => {
            const { controller, sessions, events, stream } = createController();

            await expect(
                controller.subscribeToSessionEvents("session-1", token(roles)),
            ).resolves.toBe(stream);
            expect(sessions.getForTenant).toHaveBeenCalledExactlyOnceWith(
                "tenant-1",
                "session-1",
                scope,
            );
            expect(events.getSessionEvents).toHaveBeenCalledExactlyOnceWith(
                "tenant-1",
                "session-1",
            );
        },
    );

    it("does not subscribe to a session outside the scope", async () => {
        const { controller, sessions, events } = createController();
        sessions.getForTenant.mockRejectedValue(new SessionNotFound());

        await expect(
            controller.subscribeToSessionEvents(
                "session-1",
                token([Role.PresentationRequest]),
            ),
        ).rejects.toBeInstanceOf(SessionNotFound);
        expect(events.getSessionEvents).not.toHaveBeenCalled();
    });
});
