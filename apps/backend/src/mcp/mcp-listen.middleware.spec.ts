import { describe, expect, it, vi } from "vitest";
import { RefuseMcpListenMiddleware } from "./mcp-listen.middleware.js";

function run(body: unknown, headers: Record<string, string> = {}) {
    const json = vi.fn();
    const response = { status: vi.fn().mockReturnValue({ json }) };
    const next = vi.fn();
    new RefuseMcpListenMiddleware().use(
        { body, headers } as never,
        response,
        next,
    );
    return {
        status: response.status.mock.calls[0]?.[0] as number | undefined,
        next,
        // What json() serializes into the response.
        answer: json.mock.calls[0]?.[0],
        json,
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
        const { status, next, answer } = run(listen(7), {
            "content-length": "60",
        });

        expect(next).not.toHaveBeenCalled();
        expect(status).toBe(404);
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

    it("echoes a string id", () => {
        expect(run(listen("abc")).answer.id).toBe("abc");
    });

    it.each([
        ["without an id", undefined],
        ["with an object id", { nested: true }],
    ])("answers a listen request %s with id null", (_name, id) => {
        const { status, answer } = run(listen(id));
        expect(status).toBe(404);
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
        [
            "a raw body",
            Buffer.from(JSON.stringify(listen(1))),
            { "content-length": "60" },
        ],
    ])(
        "refuses %s, which the SDK would parse itself",
        (_name, body, headers) => {
            const { status, next, answer } = run(body, headers);

            expect(next).not.toHaveBeenCalled();
            expect(status).toBe(415);
            expect(answer).toMatchObject({ id: null, error: { code: -32000 } });
        },
    );

    it.each([
        ["a tool call", { jsonrpc: "2.0", id: 1, method: "tools/call" }, {}],
        ["a batch", [listen(1)], { "content-length": "60" }],
        ["a request without a body", undefined, {}],
    ])("passes %s on to the MCP module", (_name, body, headers) => {
        const { json, next } = run(body, headers);
        expect(next).toHaveBeenCalledOnce();
        expect(json).not.toHaveBeenCalled();
    });
});
