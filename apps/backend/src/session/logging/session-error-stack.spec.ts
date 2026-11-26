import type { PinoLogger } from "nestjs-pino";
import { describe, expect, it, vi } from "vitest";
import { SessionAuditService } from "./session-audit.service.js";
import type {
    SessionLogStoreService,
    SessionStoreMode,
} from "./session-log-store.service.js";
import { SessionLoggerService } from "./session-logger.service.js";

const context = {
    sessionId: "session-1",
    tenantId: "tenant-1",
    flowType: "OID4VP" as const,
    stage: "verification",
};

function setup(storeMode: SessionStoreMode) {
    const append = vi.fn(async () => {});
    const store = { append } as unknown as SessionLogStoreService;
    const settings = { enabled: true, storeMode };
    const pino = {
        setContext: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
    } as unknown as PinoLogger;
    return {
        append,
        audit: new SessionAuditService(settings, store),
        logger: new SessionLoggerService(pino, settings, store),
    };
}

/** The detail stored with the one entry the call appended. */
function storedDetail(append: ReturnType<typeof vi.fn>) {
    expect(append).toHaveBeenCalledOnce();
    return append.mock.calls[0][4] as Record<string, unknown>;
}

describe("stored error detail", () => {
    const error = new Error("Status is not valid");

    describe.each([
        [
            "SessionAuditService.logFlowError",
            (s: ReturnType<typeof setup>) =>
                s.audit.logFlowError(context, error),
        ],
        [
            "SessionAuditService.logError",
            (s: ReturnType<typeof setup>) =>
                s.audit.logError(context, error, "Verification failed"),
        ],
        [
            "SessionLoggerService.logFlowError",
            (s: ReturnType<typeof setup>) =>
                s.logger.logFlowError(context, error),
        ],
        [
            "SessionLoggerService.logError",
            (s: ReturnType<typeof setup>) =>
                s.logger.logError(context, error, "Verification failed"),
        ],
    ])("%s", (_name, log) => {
        it("adds errorStack with LOG_SESSION_STORE=verbose", () => {
            const s = setup("verbose");
            log(s);

            expect(storedDetail(s.append)).toEqual({
                errorName: "Error",
                errorMessage: "Status is not valid",
                errorStack: error.stack,
            });
        });

        it.each(["all", "errors"] as const)(
            "stores no errorStack with LOG_SESSION_STORE=%s",
            (mode) => {
                const s = setup(mode);
                log(s);

                expect(storedDetail(s.append)).toEqual({
                    errorName: "Error",
                    errorMessage: "Status is not valid",
                });
            },
        );
    });
});
