import {
    type ArgumentsHost,
    type INestApplication,
    Injectable,
    Logger,
    Module,
    UseFilters,
} from "@nestjs/common";
import { EXCEPTION_FILTERS_METADATA } from "@nestjs/common/constants.js";
import { McpModule, Tool } from "@nestjs/mcp";
import { connectMcpClient } from "@nestjs/mcp/testing";
import { Test } from "@nestjs/testing";
import { ValidationError } from "@openid4vc/utils";
import { EntityNotFoundError } from "typeorm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AllExceptionsFilter } from "../all-exceptions.filter.js";
import { ClientIdTaken } from "../auth/client/domain/client-data.js";
import { SessionNotFound } from "../session/application/session-errors.js";
import { McpErrorFilter, toMcpHttpException } from "./mcp-error.filter.js";
import { McpToolsModule } from "./mcp-tools.module.js";

@Injectable()
@UseFilters(new McpErrorFilter())
class FailingTools {
    @Tool({ name: "missing" })
    missing() {
        throw new SessionNotFound();
    }

    @Tool({ name: "conflict" })
    conflict() {
        throw new ClientIdTaken("assistant");
    }

    @Tool({ name: "entity" })
    entity() {
        throw new EntityNotFoundError("ClientEntity", { clientId: "app" });
    }

    @Tool({ name: "invalid" })
    invalid() {
        throw new ValidationError("bad request object");
    }

    @Tool({ name: "crash" })
    crash() {
        throw new Error("connection to db-internal:5432 refused");
    }
}

@Module({ providers: [FailingTools] })
class FailingToolsModule {}

describe("McpErrorFilter", () => {
    /** What AllExceptionsFilter answers an HTTP request with. */
    function restAnswer(error: unknown) {
        const json = vi.fn();
        const status = vi.fn().mockReturnValue({ json });
        new AllExceptionsFilter().catch(error, {
            getType: () => "http",
            switchToHttp: () => ({
                getResponse: () => ({ status }),
                getRequest: () => ({ method: "GET", path: "/x", url: "/x" }),
            }),
        } as unknown as ArgumentsHost);
        return {
            status: status.mock.calls[0][0],
            message: json.mock.calls[0][0].message,
        };
    }

    it.each([
        ["development", "test"],
        ["production", "production"],
    ])("answers as the REST API in %s", (_name, nodeEnv) => {
        vi.stubEnv("NODE_ENV", nodeEnv);
        vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
        try {
            for (const error of [
                new SessionNotFound(),
                new EntityNotFoundError("ClientEntity", { clientId: "app" }),
                new ClientIdTaken("assistant"),
            ]) {
                const mcp = toMcpHttpException(error);
                expect({
                    status: mcp.getStatus(),
                    message: mcp.message,
                }).toEqual(restAnswer(error));
            }
        } finally {
            vi.unstubAllEnvs();
            vi.restoreAllMocks();
        }
    });

    it("answers a validation error with 400, as ValidationErrorFilter", () => {
        const mcp = toMcpHttpException(new ValidationError("bad"));
        expect(mcp.getStatus()).toBe(400);
        expect(mcp.message).toBe("Validation failed");
    });

    it("is applied to every tool provider", () => {
        const providers = Reflect.getMetadata(
            "providers",
            McpToolsModule,
        ) as object[];
        for (const provider of providers) {
            const filters =
                Reflect.getMetadata(EXCEPTION_FILTERS_METADATA, provider) ?? [];
            expect(
                filters.some(
                    (filter: unknown) => filter instanceof McpErrorFilter,
                ),
                String(provider),
            ).toBe(true);
        }
    });

    describe("on a tool call", () => {
        let app: INestApplication;
        let client: Awaited<ReturnType<typeof connectMcpClient>>;
        const text = async (name: string) => {
            const result = (await client.callTool({ name })) as {
                isError?: boolean;
                content: { type: string; text?: string }[];
            };
            expect(result.isError).toBe(true);
            return result.content.map((block) => block.text).join("");
        };

        beforeAll(async () => {
            const moduleRef = await Test.createTestingModule({
                imports: [
                    McpModule.forRoot({
                        name: "test",
                        version: "1.0.0",
                        include: [FailingToolsModule],
                    }),
                    FailingToolsModule,
                ],
            }).compile();
            app = moduleRef.createNestApplication({ logger: false });
            // As in production; it leaves tool calls to the MCP module.
            app.useGlobalFilters(new AllExceptionsFilter());
            await app.init();
            client = await connectMcpClient(app);
        });

        afterAll(async () => {
            await client?.close();
            await app?.close();
        });

        it("reaches the client with the mapped message", async () => {
            expect(await text("missing")).toBe("Session not found");
            expect(await text("entity")).toContain(
                'Could not find any entity of type "ClientEntity"',
            );
            expect(await text("conflict")).toBe(
                "Client ID 'assistant' is already in use",
            );
            expect(await text("invalid")).toBe("Validation failed");
        });

        it("still hides other errors", async () => {
            expect(await text("crash")).toBe("Internal server error");
        });
    });
});
