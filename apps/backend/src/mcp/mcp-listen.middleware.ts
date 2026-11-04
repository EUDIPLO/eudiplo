import type { IncomingMessage, ServerResponse } from "node:http";
import { Injectable, type NestMiddleware } from "@nestjs/common";

/** JSON-RPC "Method not found". */
const METHOD_NOT_FOUND = -32601;

/**
 * Refuses `subscriptions/listen` on the MCP endpoint before the MCP SDK opens
 * a stream for it. EUDIPLO sends nothing on these streams, and the SDK keeps
 * each one open with a keepalive, also after the token expired, from one pool
 * of 1024 per process that all tenants share. The answer is the one the SDK
 * gives for a method it does not serve: HTTP 404 with a JSON-RPC error.
 * Only single messages need it: the method belongs to protocol revision
 * 2026-07-28, which has no batches, and the 2025 fallback does not serve it.
 */
@Injectable()
export class RefuseMcpListenMiddleware implements NestMiddleware {
    use(
        request: IncomingMessage & { body?: unknown },
        response: ServerResponse,
        next: () => void,
    ): void {
        const message = request.body as
            | { method?: unknown; id?: unknown }
            | null
            | undefined;
        if (
            typeof message !== "object" ||
            message === null ||
            Array.isArray(message) ||
            message.method !== "subscriptions/listen"
        ) {
            next();
            return;
        }
        response.statusCode = 404;
        response.setHeader("Content-Type", "application/json");
        response.end(
            JSON.stringify({
                jsonrpc: "2.0",
                id: message.id ?? null,
                error: {
                    code: METHOD_NOT_FOUND,
                    message:
                        "Method not found: EUDIPLO does not serve subscriptions/listen",
                },
            }),
        );
    }
}
