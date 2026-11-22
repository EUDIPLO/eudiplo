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
        getForReader: vi.fn().mockResolvedValue({ id: "session-1" }),
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
    it("needs issuance:offer, presentation:request or sessions:read, like reading the session", () => {
        const allows = (roles: Role[]) =>
            rolesAllow(
                SessionEventsController,
                "subscribeToSessionEvents",
                roles,
            );
        expect(allows([Role.IssuanceOffer])).toBe(true);
        expect(allows([Role.PresentationRequest])).toBe(true);
        expect(allows([Role.SessionsRead])).toBe(true);
        expect(allows([Role.Issuances])).toBe(false);
        expect(allows([Role.CredentialStatus])).toBe(false);
        expect(allows([Role.Clients])).toBe(false);
        expect(allows([])).toBe(false);
    });

    it.each([
        [[Role.PresentationRequest], "presentation", []],
        [[Role.IssuanceOffer], "issuance", []],
        [[Role.IssuanceOffer, Role.PresentationRequest], undefined, []],
        [[Role.SessionsRead], undefined, ["issuance", "presentation"]],
        [[Role.SessionsRead, Role.IssuanceOffer], undefined, ["presentation"]],
    ])(
        "streams only sessions a client with %j may read (%s)",
        async (roles, scope, hideOpen) => {
            const { controller, sessions, events, stream } = createController();

            await expect(
                controller.subscribeToSessionEvents("session-1", token(roles)),
            ).resolves.toBe(stream);
            expect(sessions.getForReader).toHaveBeenCalledExactlyOnceWith(
                "tenant-1",
                "session-1",
                scope,
                hideOpen,
                {},
            );
            expect(events.getSessionEvents).toHaveBeenCalledExactlyOnceWith(
                "tenant-1",
                "session-1",
            );
        },
    );

    it("does not subscribe to a session outside the scope", async () => {
        const { controller, sessions, events } = createController();
        sessions.getForReader.mockRejectedValue(new SessionNotFound());

        await expect(
            controller.subscribeToSessionEvents(
                "session-1",
                token([Role.PresentationRequest]),
            ),
        ).rejects.toBeInstanceOf(SessionNotFound);
        expect(events.getSessionEvents).not.toHaveBeenCalled();
    });

    it("streams only sessions within the client's configuration limits", async () => {
        const { controller, sessions } = createController();
        const caller = {
            ...token([Role.PresentationRequest]),
            client: {
                clientId: "client-1",
                allowedPresentationConfigs: ["pid"],
            },
        } as unknown as TokenPayload;

        await controller.subscribeToSessionEvents("session-1", caller);

        expect(sessions.getForReader).toHaveBeenCalledExactlyOnceWith(
            "tenant-1",
            "session-1",
            "presentation",
            [],
            { presentation: ["pid"], issuance: undefined },
        );
    });
});
