import { describe, expect, it, vi } from "vitest";
import { RefuseMcpListenMiddleware } from "./mcp-listen.middleware.js";

function run(body: unknown) {
    const response = {
        statusCode: 200,
        setHeader: vi.fn(),
        end: vi.fn(),
    };
    const next = vi.fn();
    new RefuseMcpListenMiddleware().use(
        { body } as never,
        response as never,
        next,
    );
    return { response, next };
}

describe("RefuseMcpListenMiddleware", () => {
    it("answers subscriptions/listen with a JSON-RPC method-not-found error", () => {
        const { response, next } = run({
            jsonrpc: "2.0",
            id: 7,
            method: "subscriptions/listen",
            params: {},
        });

        expect(next).not.toHaveBeenCalled();
        expect(response.statusCode).toBe(404);
        expect(response.setHeader).toHaveBeenCalledWith(
            "Content-Type",
            "application/json",
        );
        expect(JSON.parse(response.end.mock.calls[0][0])).toEqual({
            jsonrpc: "2.0",
            id: 7,
            error: {
                code: -32601,
                message:
                    "Method not found: EUDIPLO does not serve subscriptions/listen",
            },
        });
    });

    it.each([
        ["a tool call", { jsonrpc: "2.0", id: 1, method: "tools/call" }],
        ["a batch", [{ jsonrpc: "2.0", id: 1, method: "tools/list" }]],
        ["no body", undefined],
        ["a string", "subscriptions/listen"],
    ])("passes %s on to the MCP module", (_name, body) => {
        const { response, next } = run(body);
        expect(next).toHaveBeenCalledOnce();
        expect(response.end).not.toHaveBeenCalled();
    });
});
