import { Writable } from "node:stream";
import { type Span, trace } from "@opentelemetry/api";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import {
    bindSessionToLogContext,
    logContextMixin,
    runWithLogContext,
} from "./log-context.js";

const session = { id: "session-1", tenantId: "tenant-1" };

function fakeSpan() {
    return { setAttributes: vi.fn() } as unknown as Span & {
        setAttributes: ReturnType<typeof vi.fn>;
    };
}

describe("log context", () => {
    it("adds the bound session to every later log line of the request", async () => {
        const lines: Record<string, unknown>[] = [];
        const logger = pino(
            { mixin: logContextMixin },
            new Writable({
                write(chunk, _encoding, done) {
                    lines.push(JSON.parse(chunk.toString()));
                    done();
                },
            }),
        );

        await runWithLogContext(async () => {
            logger.info("before");
            await Promise.resolve();
            bindSessionToLogContext(session);
            await new Promise((resolve) => setTimeout(resolve, 1));
            logger.child({ context: "Service" }).info("after");
            logger.info({ sessionId: "explicit" }, "explicit");
        });
        logger.info("outside");

        expect(
            lines.map(({ msg, sessionId, tenantId }) => ({
                msg,
                sessionId,
                tenantId,
            })),
        ).toEqual([
            { msg: "before", sessionId: undefined, tenantId: undefined },
            { msg: "after", sessionId: "session-1", tenantId: "tenant-1" },
            { msg: "explicit", sessionId: "explicit", tenantId: "tenant-1" },
            { msg: "outside", sessionId: undefined, tenantId: undefined },
        ]);
    });

    it("keeps requests apart", async () => {
        const seen = await Promise.all(
            ["a", "b"].map((id) =>
                runWithLogContext(async () => {
                    bindSessionToLogContext({ id, tenantId: "tenant" });
                    await new Promise((resolve) => setTimeout(resolve, 1));
                    return logContextMixin().sessionId;
                }),
            ),
        );
        expect(seen).toEqual(["a", "b"]);
    });

    it("stays bound to the first session of the request", () => {
        runWithLogContext(() => {
            bindSessionToLogContext(session);
            bindSessionToLogContext({ id: "session-2", tenantId: "tenant-2" });
            expect(logContextMixin()).toEqual({
                sessionId: "session-1",
                tenantId: "tenant-1",
            });
        });
    });

    it("is a no-op outside a request", () => {
        bindSessionToLogContext(session);
        expect(logContextMixin()).toEqual({});
    });

    it("sets session.id on the request span and the current span", () => {
        const requestSpan = fakeSpan();
        const handlerSpan = fakeSpan();
        const otherHandlerSpan = fakeSpan();
        const getActiveSpan = vi.spyOn(trace, "getActiveSpan");
        try {
            getActiveSpan.mockReturnValue(requestSpan);
            runWithLogContext(() => {
                getActiveSpan.mockReturnValue(handlerSpan);
                bindSessionToLogContext(session);
                getActiveSpan.mockReturnValue(otherHandlerSpan);
                bindSessionToLogContext({ id: "session-2", tenantId: "t" });
            });
        } finally {
            getActiveSpan.mockRestore();
        }
        const attributes = {
            "session.id": "session-1",
            "session.tenantId": "tenant-1",
        };
        expect(requestSpan.setAttributes).toHaveBeenCalledExactlyOnceWith(
            attributes,
        );
        expect(handlerSpan.setAttributes).toHaveBeenCalledExactlyOnceWith(
            attributes,
        );
        expect(otherHandlerSpan.setAttributes).toHaveBeenCalledExactlyOnceWith({
            "session.id": "session-2",
            "session.tenantId": "t",
        });
    });
});
