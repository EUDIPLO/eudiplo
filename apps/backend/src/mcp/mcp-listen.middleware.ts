import type { IncomingMessage, ServerResponse } from "node:http";
import { METHOD_NOT_FOUND } from "@modelcontextprotocol/server";
import { Injectable, type NestMiddleware } from "@nestjs/common";

/** The code the MCP SDK answers a body that is not JSON with. */
const UNSUPPORTED_MEDIA_TYPE = -32000;

/** Whether the request has a body, as Express's body parsers decide it. */
function hasBody(request: IncomingMessage): boolean {
    return (
        request.headers["transfer-encoding"] !== undefined ||
        request.headers["content-length"] !== undefined
    );
}

/** A body Express's JSON parser produced: a plain object or an array. */
function isParsedJson(body: unknown): body is object {
    return (
        Array.isArray(body) ||
        (typeof body === "object" &&
            body !== null &&
            Object.getPrototypeOf(body) === Object.prototype)
    );
}

function reply(
    response: ServerResponse,
    status: number,
    id: unknown,
    code: number,
    message: string,
): void {
    response.statusCode = status;
    response.setHeader("Content-Type", "application/json");
    response.end(
        JSON.stringify({
            jsonrpc: "2.0",
            // The SDK echoes only string and number IDs.
            id: typeof id === "string" || typeof id === "number" ? id : null,
            error: { code, message },
        }),
    );
}

/**
 * Refuses `subscriptions/listen` on the MCP endpoint before the MCP SDK opens
 * a stream for it. EUDIPLO sends nothing on these streams, and the SDK keeps
 * each one open with a keepalive, also after the token expired, from one pool
 * of 1024 per process that all tenants share. The answer is the one the SDK
 * gives for a method it does not serve: HTTP 404 with a JSON-RPC error.
 *
 * The SDK parses a body itself when Express did not, and accepts content
 * types that Express's JSON parser skips (a trailing no-break space, for
 * example), so a body this middleware cannot read is refused as well, with
 * the SDK's own answer to a body that is not JSON. Batches go on: the SDK
 * refuses 2026-07-28 messages in them, and only that revision has the
 * method.
 */
@Injectable()
export class RefuseMcpListenMiddleware implements NestMiddleware {
    use(
        request: IncomingMessage & { body?: unknown },
        response: ServerResponse,
        next: () => void,
    ): void {
        const { body } = request;
        if (!isParsedJson(body)) {
            if (hasBody(request)) {
                reply(
                    response,
                    415,
                    null,
                    UNSUPPORTED_MEDIA_TYPE,
                    "Unsupported Media Type: Content-Type must be application/json",
                );
                return;
            }
            // Without a body, the SDK has nothing to open a stream for.
            next();
            return;
        }
        const message = body as { method?: unknown; id?: unknown };
        if (Array.isArray(body) || message.method !== "subscriptions/listen") {
            next();
            return;
        }
        reply(
            response,
            404,
            message.id,
            METHOD_NOT_FOUND,
            "Method not found: EUDIPLO does not serve subscriptions/listen",
        );
    }
}
