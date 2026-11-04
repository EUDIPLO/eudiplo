import type { ExecutionContext } from "@nestjs/common";
import { trace } from "@opentelemetry/api";
import { firstValueFrom, of } from "rxjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TraceIdInterceptor } from "./trace-id.interceptor.js";

const traceId = "0af7651916cd43dd8448eb211c80319c";

function activeSpan() {
    vi.spyOn(trace, "getActiveSpan").mockReturnValue({
        spanContext: () => ({ traceId }),
    } as any);
}

describe("TraceIdInterceptor", () => {
    afterEach(() => vi.restoreAllMocks());

    it("adds the trace ID to HTTP responses", async () => {
        activeSpan();
        const setHeader = vi.fn();
        const context = {
            getType: () => "http",
            switchToHttp: () => ({ getResponse: () => ({ setHeader }) }),
        } as unknown as ExecutionContext;

        await firstValueFrom(
            new TraceIdInterceptor().intercept(context, {
                handle: () => of("ok"),
            }),
        );

        expect(setHeader).toHaveBeenCalledWith("X-Trace-Id", traceId);
    });

    it("passes MCP tool calls through, which have no response of their own", async () => {
        activeSpan();
        const switchToHttp = vi.fn();
        const context = {
            getType: () => "mcp",
            switchToHttp,
        } as unknown as ExecutionContext;

        await expect(
            firstValueFrom(
                new TraceIdInterceptor().intercept(context, {
                    handle: () => of("ok"),
                }),
            ),
        ).resolves.toBe("ok");
        expect(switchToHttp).not.toHaveBeenCalled();
    });
});
