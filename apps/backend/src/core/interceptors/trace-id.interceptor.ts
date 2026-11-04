import {
    CallHandler,
    ExecutionContext,
    Injectable,
    NestInterceptor,
} from "@nestjs/common";
import { trace } from "@opentelemetry/api";
import { Response } from "express";
import { Observable } from "rxjs";

/**
 * Interceptor that adds the OpenTelemetry trace ID to HTTP response headers.
 * This enables clients to correlate their requests with backend traces in
 * observability tools like Grafana Tempo.
 *
 * Response headers added:
 * - `X-Trace-Id`: The trace ID in hex format (e.g., "abc123def456...")
 *
 * Usage: Clients can use this header to search for traces in Grafana:
 * Explore → Tempo → TraceQL: `{ trace:id="<X-Trace-Id value>" }`
 */
@Injectable()
export class TraceIdInterceptor implements NestInterceptor {
    intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
        // MCP tool calls run through global interceptors too; the HTTP
        // response of their endpoint is not theirs to change.
        if (context.getType() !== "http") {
            return next.handle();
        }
        const response = context.switchToHttp().getResponse<Response>();
        const span = trace.getActiveSpan();

        if (span) {
            const traceId = span.spanContext().traceId;
            response.setHeader("X-Trace-Id", traceId);
        }

        return next.handle();
    }
}
