import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import type { ConfigService } from "@nestjs/config";
import { pinoHttp } from "pino-http";
import { afterEach, describe, expect, it } from "vitest";
import { createLoggerOptions } from "./logger.factory.js";
import { redactUrl } from "./redact-url.js";

const CODE = "DEMO_PREAUTH_CODE";

describe("redactUrl", () => {
    it.each([
        ["/api/session?q=secret", "/api/session?q=[redacted]"],
        [
            "/api/session?status=failed&q=secret&page=2",
            "/api/session?status=failed&q=[redacted]&page=2",
        ],
        ["/api/session?q=a&q=b", "/api/session?q=[redacted]&q=[redacted]"],
        ["/api/session?%71=secret", "/api/session?%71=[redacted]"],
        ["/api/session?q", "/api/session?q=[redacted]"],
        ["/api/session?q=secret#top", "/api/session?q=[redacted]#top"],
        ["/api/session?query=kept&aq=kept", "/api/session?query=kept&aq=kept"],
        ["/api/session", "/api/session"],
        ["/api/session?q=%E0%A4%A", "/api/session?q=[redacted]"],
    ])("%s → %s", (url, expected) => {
        expect(redactUrl(url)).toBe(expected);
    });

    it("leaves an absent URL absent", () => {
        expect(redactUrl(undefined)).toBeUndefined();
    });
});

describe("HTTP logging of the session search", () => {
    let server: Server | undefined;

    afterEach(() => {
        server?.close();
        server = undefined;
    });

    /** Run requests through the production pino-http options and collect the log lines. */
    async function logsOf(paths: string[]): Promise<string[]> {
        const settings: Record<string, unknown> = {
            LOG_ENABLE_HTTP_LOGGER: true,
            LOG_HTTP_RESPONSE_BODY: false,
            LOG_TO_FILE: false,
            LOG_FILE_PATH: "",
            LOG_HTTP_RESPONSE_BODY_MAX_LENGTH: 0,
            LOG_REDACT_SENSITIVE_DATA: true,
            OTEL_SDK_DISABLED: true,
            LOG_LEVEL: "debug",
        };
        const config = {
            getOrThrow: (key: string) => settings[key],
            get: () => undefined,
        } as unknown as ConfigService;
        const { transport: _transport, ...options } = (
            createLoggerOptions(config) as { pinoHttp: Record<string, any> }
        ).pinoHttp;
        const lines: string[] = [];
        const logging = pinoHttp(
            options,
            new Writable({
                write(chunk, _encoding, done) {
                    lines.push(chunk.toString());
                    done();
                },
            }),
        );
        server = createServer((req, res) => {
            logging(req, res);
            // A request-scoped error log, as the exception filter writes it.
            req.log.error("request failed");
            res.statusCode = 400;
            res.end();
        });
        await new Promise<void>((resolve) =>
            server!.listen(0, "127.0.0.1", resolve),
        );
        const { port } = server.address() as AddressInfo;
        for (const path of paths)
            await fetch(`http://127.0.0.1:${port}${path}`);
        return lines;
    }

    it("never logs the search term, in error logs or access logs", async () => {
        const offer = `openid-credential-offer://?credential_offer=${encodeURIComponent(
            JSON.stringify({
                grants: {
                    "urn:ietf:params:oauth:grant-type:pre-authorized_code": {
                        "pre-authorized_code": CODE,
                    },
                },
            }),
        )}`;
        const lines = await logsOf([
            // Management API: excluded from access logs, not from error logs.
            `/api/session?status=failed&q=${CODE}`,
            `/api/session?q=${encodeURIComponent(offer)}`,
            // A logged path, so the access log messages are covered too.
            `/session?q=${CODE}`,
        ]);

        const parsed = lines.map((line) => JSON.parse(line));
        const messages = parsed.map((line) => line.msg as string);
        expect(messages.filter((msg) => msg === "request failed")).toHaveLength(
            3,
        );
        expect(messages).toContain("--> GET /session?q=[redacted]");
        expect(messages).toContainEqual(
            expect.stringMatching(/^<-- GET \/session\?q=\[redacted\] 400 /),
        );
        expect(parsed[0].req.url).toBe(
            "/api/session?status=failed&q=[redacted]",
        );
        expect(lines.join("\n")).not.toContain(CODE);
        expect(lines.join("\n")).not.toContain("pre-authorized_code");
    });
});
