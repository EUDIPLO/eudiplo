import { IncomingMessage } from "node:http";
import { ConfigService } from "@nestjs/config";
import { Params } from "nestjs-pino";
import { SerializedRequest, SerializedResponse } from "pino";
import { logContextMixin } from "./log-context.js";
import { redactUrl } from "./redact-url.js";

/**
 * Content types we consider safe to buffer and stringify for logs. Anything else
 * (binary uploads/downloads, streaming) is skipped entirely.
 */
function isLoggableContentType(contentType: string | undefined): boolean {
    const normalized = (contentType || "").toLowerCase();
    return (
        normalized === "" ||
        normalized.includes("json") ||
        normalized.startsWith("text/") ||
        normalized.includes("xml") ||
        normalized.includes("javascript") ||
        normalized.includes("x-www-form-urlencoded")
    );
}

function truncate(value: string, maxLength?: number): string {
    if (maxLength === undefined || value.length <= maxLength) {
        return value;
    }

    return `${value.slice(0, maxLength)}...[truncated]`;
}

function serializeResponseBody(
    rawBody: Buffer,
    contentType: string | undefined,
    maxLength?: number,
): unknown {
    if (!rawBody.length) {
        return undefined;
    }

    const bodyText = truncate(rawBody.toString("utf8"), maxLength);

    if ((contentType || "").toLowerCase().includes("json")) {
        try {
            return JSON.parse(bodyText);
        } catch {
            return bodyText;
        }
    }

    return bodyText;
}

function attachResponseBodyCapture(
    req: any,
    res: any,
    maxLoggedResponseBodyLength?: number,
): void {
    const response = res?.raw ?? res;
    if (!response || response.__eudiploResponseBodyCaptureInstalled) {
        return;
    }

    response.__eudiploResponseBodyCaptureInstalled = true;

    const originalWrite = response.write?.bind(response);
    const originalEnd = response.end?.bind(response);

    if (
        typeof originalWrite !== "function" ||
        typeof originalEnd !== "function"
    ) {
        return;
    }

    // Skip streaming/binary responses upfront (checked on first write/end).
    let capturing: boolean | undefined;
    const chunks: Buffer[] = [];
    let totalLength = 0;

    const shouldCapture = (): boolean => {
        if (capturing !== undefined) {
            return capturing;
        }
        const responseContentType =
            typeof response.getHeader === "function"
                ? String(response.getHeader("content-type") || "")
                : undefined;
        capturing = isLoggableContentType(responseContentType);
        if (!capturing) {
            response.__eudiploLoggedResponseBody =
                "[non-text response omitted]";
        }
        return capturing;
    };

    const pushChunk = (chunk: unknown): void => {
        if (chunk === undefined || chunk === null || !shouldCapture()) {
            return;
        }
        if (
            maxLoggedResponseBodyLength !== undefined &&
            totalLength >= maxLoggedResponseBodyLength
        ) {
            return;
        }
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        if (maxLoggedResponseBodyLength === undefined) {
            chunks.push(buf);
            totalLength += buf.length;
            return;
        }
        const remaining = maxLoggedResponseBodyLength - totalLength;
        chunks.push(buf.length > remaining ? buf.subarray(0, remaining) : buf);
        totalLength += Math.min(buf.length, remaining);
    };

    response.write = (chunk: unknown, ...args: unknown[]) => {
        pushChunk(chunk);
        return originalWrite(chunk, ...args);
    };

    response.end = (chunk?: unknown, ...args: unknown[]) => {
        pushChunk(chunk);

        if (capturing !== false) {
            const responseContentType =
                typeof response.getHeader === "function"
                    ? String(response.getHeader("content-type") || "")
                    : undefined;
            const bodyBuffer =
                chunks.length > 0 ? Buffer.concat(chunks) : Buffer.alloc(0);
            response.__eudiploLoggedResponseBody = serializeResponseBody(
                bodyBuffer,
                responseContentType,
                maxLoggedResponseBodyLength,
            );
        }

        return originalEnd(chunk, ...args);
    };
}

/**
 * Identifiers in the path of wallet-facing routes. The OID4VP routes carry the
 * wallet nonce, which is not the session id (OID4VP Section 13.3); the session
 * id is added by the log context once the request resolved its session.
 */
function pathIdentifiers(url: string | undefined): Record<string, string> {
    let pathname: string;
    try {
        pathname = decodeURI(new URL(url ?? "", "http://localhost").pathname);
    } catch {
        return {};
    }
    const walletNonce = /^\/presentations\/([^/]+)\/oid4vp(?:\/|$)/.exec(
        pathname,
    )?.[1];
    const tenantId = /^\/issuers\/([^/]+)\//.exec(pathname)?.[1];
    return {
        ...(walletNonce ? { walletNonce } : {}),
        ...(tenantId ? { tenantId } : {}),
    };
}

/**
 * Factory function for configuring the logger module
 *
 * Logging targets:
 * - Console: pino-pretty for human-readable output
 * - File: JSON logs (optional, via LOG_TO_FILE)
 * - OpenTelemetry: pino-opentelemetry-transport sends logs to OTel Collector
 *
 * Trace correlation:
 * - @opentelemetry/instrumentation-pino automatically injects trace_id/span_id
 * - pino-opentelemetry-transport forwards context to OTel logs pipeline
 *
 * Session correlation (with or without OTel):
 * - once a request resolved its session, every following log line of that
 *   request carries `sessionId` and `tenantId` (see `log-context.ts`)
 *
 * @param configService The config service instance
 * @returns The logger configuration object
 */
export const createLoggerOptions = (configService: ConfigService) => {
    // Disable pino-http's autoLogging - we handle HTTP logging explicitly
    const enableHttpLogger = configService.getOrThrow<boolean>(
        "LOG_ENABLE_HTTP_LOGGER",
    );

    // Opt-in response body capture. Disabled by default because response bodies
    // can contain access tokens, credentials, and other secrets.
    const captureResponseBody = configService.getOrThrow<boolean>(
        "LOG_HTTP_RESPONSE_BODY",
    );

    // Check if file logging is enabled
    const logToFile = configService.getOrThrow<boolean>("LOG_TO_FILE");
    const logFilePath = configService.getOrThrow<string>("LOG_FILE_PATH");
    const logHttpResponseBodyMaxLength = configService.getOrThrow<number>(
        "LOG_HTTP_RESPONSE_BODY_MAX_LENGTH",
    );
    const redactSensitiveData = configService.getOrThrow<boolean>(
        "LOG_REDACT_SENSITIVE_DATA",
    );
    const maxLoggedResponseBodyLength =
        logHttpResponseBodyMaxLength > 0
            ? logHttpResponseBodyMaxLength
            : undefined;

    // Check if OTel is disabled
    const otelDisabled = configService.getOrThrow<boolean>("OTEL_SDK_DISABLED");
    const logLevel = configService.getOrThrow("LOG_LEVEL");

    // Build transport targets array
    const targets: any[] = [
        // Console pretty logging (always enabled)
        {
            target: "pino-pretty",
            level: logLevel,
            options: {
                colorize: true,
                singleLine: false,
                translateTime: "yyyy-mm-dd HH:MM:ss",
                ignore: "pid,hostname,req,res,responseTime,context",
                messageFormat: "{if context}[{context}] {end}{msg}",
            },
        },
    ];

    // Optional: File logging
    if (logToFile && logFilePath) {
        targets.push({
            target: "pino/file",
            level: logLevel,
            options: {
                destination: logFilePath,
                mkdir: true,
                sync: true, // Use synchronous writes to ensure message order
            },
        });
    }

    // Optional: OpenTelemetry transport (sends logs to OTel Collector → Loki)
    // This is how pino logs get trace correlation and appear in Grafana/Loki
    if (!otelDisabled) {
        targets.push({
            target: "pino-opentelemetry-transport",
            level: logLevel,
            options: {
                // Resource attributes must be explicitly passed to the transport
                // (it doesn't inherit from the OTel SDK automatically)
                resourceAttributes: {
                    "service.name":
                        configService.get("OTEL_SERVICE_NAME") ||
                        "eudiplo-backend",
                    "service.version":
                        configService.get("VERSION") || "unknown",
                },
            },
        });
    }

    const redact = redactSensitiveData
        ? {
              paths: [
                  "req.headers.authorization",
                  "req.headers.cookie",
                  "req.headers.dpop",
                  'req.headers["oauth-client-attestation"]',
                  'req.headers["oauth-client-attestation-pop"]',
                  'res.headers["set-cookie"]',
                  "res.body.access_token",
                  "res.body.refresh_token",
                  "res.body.id_token",
                  "res.body.c_nonce",
                  "res.body.credential",
                  "res.body.credentials",
                  "res.body.attestation_challenge",
              ],
              censor: "[redacted]",
          }
        : undefined;

    return {
        pinoHttp: {
            level: logLevel,
            autoLogging: {
                ignore: (req: IncomingMessage) => {
                    if (!enableHttpLogger) {
                        return true;
                    }
                    // Parse the pathname so query strings and substrings like
                    // "/foo/api-docs" don't accidentally match.
                    const pathname = new URL(req.url ?? "", "http://localhost")
                        .pathname;
                    return (
                        pathname.startsWith("/api") ||
                        pathname === "/health" ||
                        pathname === "/metrics"
                    );
                },
            },
            // Redact sensitive request/response fields unless explicitly disabled.
            redact,
            transport: {
                targets,
            },
            // Put request/response essentials directly into `msg` so they
            // remain visible after pino-pretty ignores nested req/res fields.
            customReceivedMessage: (req: IncomingMessage) =>
                `--> ${req.method} ${redactUrl(req.url)}`,
            customSuccessMessage: (
                req: IncomingMessage,
                res: { statusCode: number },
                responseTime: number,
            ) =>
                `<-- ${req.method} ${redactUrl(req.url)} ${res.statusCode} ${Math.round(responseTime)}ms`,
            customErrorMessage: (
                req: IncomingMessage,
                res: { statusCode: number },
                err: Error,
            ) =>
                `<-- ${req.method} ${redactUrl(req.url)} ${res.statusCode} ${err.message}`,
            mixin: logContextMixin,
            formatters: {
                log: (object: any) => {
                    object.hostname = undefined;
                    return object;
                },
            },
            customProps: (req: any, res: any) => {
                if (captureResponseBody) {
                    attachResponseBodyCapture(
                        req,
                        res,
                        maxLoggedResponseBodyLength,
                    );
                }
                return {};
            },
            serializers: {
                req: (req: SerializedRequest) => ({
                    method: req.method,
                    // Bound to every log line of the request, errors included.
                    url: redactUrl(req.url),
                    headers: {
                        "user-agent": req.headers["user-agent"],
                        "content-type": req.headers["content-type"],
                    },
                    // Serialized when the request starts, before routing
                    // sets `req.params`, so read the path itself.
                    ...pathIdentifiers(req.url),
                }),
                res: (res: SerializedResponse & { raw?: any }) => {
                    return {
                        statusCode: res.statusCode,
                        body: captureResponseBody
                            ? res.raw?.__eudiploLoggedResponseBody
                            : undefined,
                    };
                },
            },
        },
        forRoutes: ["*splat"],
    } as Params;
};
