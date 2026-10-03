import { describe, expect, it, vi } from "vitest";
import type { SessionData } from "../../../session/domain/session-data.js";
import { SessionStatus } from "../../../session/domain/session-state.js";
import { SessionNotUsable } from "../../../session/domain/session-usability.js";
import { RetrievePresentationRequest } from "./retrieve-presentation-request.js";

const session = (requestObject?: string, values: Partial<SessionData> = {}) =>
    ({
        id: "session-1",
        tenantId: "tenant-1",
        status: SessionStatus.Active,
        requestObject,
        ...values,
    }) as SessionData;

function setup(update = vi.fn().mockResolvedValue(1)) {
    const executeFrom = vi.fn().mockResolvedValue(true);
    return {
        update,
        executeFrom,
        useCase: new RetrievePresentationRequest(
            { updateForTenant: update },
            { executeFrom },
        ),
    };
}

describe("RetrievePresentationRequest", () => {
    it("returns the cached JWT without regenerating it", async () => {
        const { update, useCase } = setup(vi.fn());
        const generate = vi.fn();

        await expect(
            useCase.execute(
                session("cached.jwt.value"),
                "https://wallet.example",
                false,
                generate,
            ),
        ).resolves.toBe("cached.jwt.value");
        expect(generate).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
    });

    it("clears redirect state for a cached no-redirect request", async () => {
        const { update, useCase } = setup();

        await expect(
            useCase.execute(
                session("cached.jwt.value"),
                "origin",
                true,
                vi.fn(),
            ),
        ).resolves.toBe("cached.jwt.value");
        expect(update).toHaveBeenCalledExactlyOnceWith(
            "tenant-1",
            "session-1",
            {
                redirectUri: null,
            },
        );
    });

    it("generates once and persists the request object", async () => {
        const { update, useCase } = setup();
        const generate = vi.fn().mockResolvedValue("generated.jwt.value");

        await expect(
            useCase.execute(
                session(),
                "https://wallet.example",
                false,
                generate,
            ),
        ).resolves.toBe("generated.jwt.value");
        expect(generate).toHaveBeenCalledExactlyOnceWith(
            "session-1",
            "https://wallet.example",
            false,
        );
        expect(update).toHaveBeenCalledExactlyOnceWith(
            "tenant-1",
            "session-1",
            {
                requestObject: "generated.jwt.value",
            },
        );
    });

    it("marks only an active session as fetched once the request is served", async () => {
        const { executeFrom, useCase } = setup();
        const current = session("cached.jwt.value");

        await useCase.execute(current, "origin", false, vi.fn());

        expect(executeFrom).toHaveBeenCalledExactlyOnceWith(
            current,
            [SessionStatus.Active],
            SessionStatus.Fetched,
        );
    });

    it.each([
        ["past its expiry", { expiresAt: new Date(Date.now() - 1) }],
        ["marked expired", { status: SessionStatus.Expired }],
        ["completed", { status: SessionStatus.Completed }],
        ["failed", { status: SessionStatus.Failed }],
    ])(
        "rejects a request %s without serving or changing it",
        async (_case, values) => {
            const { update, executeFrom, useCase } = setup();
            const generate = vi.fn();

            await expect(
                useCase.execute(
                    session("cached.jwt.value", values),
                    "origin",
                    true,
                    generate,
                ),
            ).rejects.toBeInstanceOf(SessionNotUsable);
            expect(generate).not.toHaveBeenCalled();
            expect(update).not.toHaveBeenCalled();
            expect(executeFrom).not.toHaveBeenCalled();
        },
    );

    it("serves a fetched request again before it expires", async () => {
        const { useCase } = setup();

        await expect(
            useCase.execute(
                session("cached.jwt.value", {
                    status: SessionStatus.Fetched,
                    expiresAt: new Date(Date.now() + 60_000),
                }),
                "origin",
                false,
                vi.fn(),
            ),
        ).resolves.toBe("cached.jwt.value");
    });
});
