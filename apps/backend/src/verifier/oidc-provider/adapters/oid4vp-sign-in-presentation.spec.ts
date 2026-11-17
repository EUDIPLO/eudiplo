import { describe, expect, test } from "vitest";
import { SessionNotFound } from "../../../session/application/session-errors.js";
import { SessionStatus } from "../../../session/domain/session-state.js";
import { Oid4vpSignInPresentation } from "./oid4vp-sign-in-presentation.js";

const now = new Date("2026-01-01T10:00:00Z");

function adapter(options: {
    session?: Record<string, unknown> | Error;
    configs?: Record<string, unknown>[];
}) {
    const oid4vp = {
        createRequest: async () => ({
            uri: "client_id=a&request_uri=b",
            crossDeviceUri: "client_id=a&request_uri=c",
            session: "session-1",
        }),
    };
    const configs = {
        getPresentationConfigs: async () => options.configs ?? [],
    };
    const sessions = {
        getForTenant: async () => {
            if (options.session instanceof Error) throw options.session;
            return options.session;
        },
    };
    return new Oid4vpSignInPresentation(
        oid4vp as never,
        configs as never,
        sessions as never,
        "https://eudiplo.example",
        () => now,
    );
}

describe("Oid4vpSignInPresentation", () => {
    test("starts a request and returns both wallet requests", async () => {
        await expect(
            adapter({}).start("t", "pid", "https://cb"),
        ).resolves.toEqual({
            sessionId: "session-1",
            sameDeviceRequest: "openid4vp://?client_id=a&request_uri=b",
            crossDeviceRequest: "openid4vp://?client_id=a&request_uri=c",
        });
    });

    test("refuses a missing config and one with transaction data", async () => {
        const configs = [
            { id: "pid" },
            { id: "pay", transaction_data: [{ type: "payment" }] },
        ];
        expect(await adapter({ configs }).unusableReason("t", "pid")).toBe(
            undefined,
        );
        expect(await adapter({ configs }).unusableReason("t", "pay")).toContain(
            "transaction data",
        );
        expect(
            await adapter({ configs }).unusableReason("t", "missing"),
        ).toContain("does not exist");
    });

    test("maps a completed session and tells cross-device by the cleared redirect", async () => {
        const session = {
            status: SessionStatus.Completed,
            redirectUri: null,
            responseCode: "rc",
            credentials: [{ id: "pid" }],
        };
        expect(await adapter({ session }).result("t", "s")).toEqual({
            status: "completed",
            crossDevice: true,
            responseCode: "rc",
            credentials: [{ id: "pid" }],
        });
        expect(
            (
                await adapter({
                    session: { ...session, redirectUri: "https://cb" },
                }).result("t", "s")
            ).crossDevice,
        ).toBe(false);
    });

    test.each([
        [SessionStatus.Failed, "failed"],
        [SessionStatus.Cancelled, "failed"],
        [SessionStatus.Expired, "expired"],
    ])("maps %s to %s", async (status, expected) => {
        const result = await adapter({
            session: { status, outcome: { message: "revoked" } },
        }).result("t", "s");
        expect(result.status).toBe(expected);
        if (expected === "failed") expect(result.failureReason).toBe("revoked");
    });

    test("an open session past its expiry is expired", async () => {
        const result = await adapter({
            session: {
                status: SessionStatus.Fetched,
                expiresAt: new Date(now.getTime() - 1000),
            },
        }).result("t", "s");
        expect(result.status).toBe("expired");
        expect(
            (
                await adapter({
                    session: {
                        status: SessionStatus.Active,
                        expiresAt: new Date(now.getTime() + 1000),
                    },
                }).result("t", "s")
            ).status,
        ).toBe("open");
    });

    test("a deleted session is expired; other errors are not swallowed", async () => {
        expect(
            (await adapter({ session: new SessionNotFound() }).result("t", "s"))
                .status,
        ).toBe("expired");
        await expect(
            adapter({ session: new Error("database down") }).result("t", "s"),
        ).rejects.toThrow("database down");
    });
});
