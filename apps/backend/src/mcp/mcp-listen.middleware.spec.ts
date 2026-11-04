import { describe, expect, it, vi } from "vitest";
import { RefuseMcpListenMiddleware } from "./mcp-listen.middleware.js";

function run(body: unknown, headers: Record<string, string> = {}) {
    const response = {
        statusCode: 200,
        setHeader: vi.fn(),
        end: vi.fn(),
    };
    const next = vi.fn();
    new RefuseMcpListenMiddleware().use(
        { body, headers } as never,
        response as never,
        next,
    );
    const answer = response.end.mock.calls[0]?.[0];
    return {
        response,
        next,
        answer: answer === undefined ? undefined : JSON.parse(answer),
    };
}

const listen = (id?: unknown) => ({
    jsonrpc: "2.0",
    ...(id !== undefined && { id }),
    method: "subscriptions/listen",
    params: {},
});

describe("RefuseMcpListenMiddleware", () => {
    it("answers subscriptions/listen with a JSON-RPC method-not-found error", () => {
        const { response, next, answer } = run(listen(7), {
            "content-length": "60",
        });

        expect(next).not.toHaveBeenCalled();
        expect(response.statusCode).toBe(404);
        expect(response.setHeader).toHaveBeenCalledWith(
            "Content-Type",
            "application/json",
        );
        expect(answer).toEqual({
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
        ["without an id", undefined],
        ["with an object id", { nested: true }],
    ])("answers a listen request %s with id null", (_name, id) => {
        const { response, answer } = run(listen(id));
        expect(response.statusCode).toBe(404);
        expect(answer.id).toBeNull();
    });

    it.each([
        ["a body Express did not parse", undefined, { "content-length": "90" }],
        ["a chunked body", undefined, { "transfer-encoding": "chunked" }],
        [
            "a body parsed as text",
            "subscriptions/listen",
            { "content-length": "20" },
        ],
    ])(
        "refuses %s, which the SDK would parse itself",
        (_name, body, headers) => {
            const { response, next, answer } = run(body, headers);

            expect(next).not.toHaveBeenCalled();
            expect(response.statusCode).toBe(415);
            expect(answer).toMatchObject({ id: null, error: { code: -32000 } });
        },
    );

    it.each([
        ["a tool call", { jsonrpc: "2.0", id: 1, method: "tools/call" }, {}],
        ["a batch", [listen(1)], { "content-length": "60" }],
        ["a request without a body", undefined, {}],
    ])("passes %s on to the MCP module", (_name, body, headers) => {
        const { response, next } = run(body, headers);
        expect(next).toHaveBeenCalledOnce();
        expect(response.end).not.toHaveBeenCalled();
    });
});
