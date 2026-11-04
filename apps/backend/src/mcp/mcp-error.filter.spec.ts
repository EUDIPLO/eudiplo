import {
    ConflictException,
    type INestApplication,
    Injectable,
    Module,
    NotFoundException,
    UseFilters,
} from "@nestjs/common";
import { EXCEPTION_FILTERS_METADATA } from "@nestjs/common/constants.js";
import { McpModule, Tool } from "@nestjs/mcp";
import { connectMcpClient } from "@nestjs/mcp/testing";
import { Test } from "@nestjs/testing";
import { ValidationError } from "@openid4vc/utils";
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

    @Tool({ name: "crash" })
    crash() {
        throw new Error("connection to db-internal:5432 refused");
    }
}

@Module({ providers: [FailingTools] })
class FailingToolsModule {}

describe("McpErrorFilter", () => {
    it("maps missing resources, conflicts and validation errors as the REST filters do", () => {
        expect(toMcpHttpException(new SessionNotFound())).toEqual(
            new NotFoundException("Session not found"),
        );
        expect(toMcpHttpException(new ClientIdTaken("assistant"))).toEqual(
            new ConflictException("Client ID 'assistant' is already in use"),
        );
        expect(toMcpHttpException(new ValidationError("bad")).getStatus()).toBe(
            400,
        );
    });

    it("keeps the message of a missing resource out of production answers", () => {
        vi.stubEnv("NODE_ENV", "production");
        try {
            expect(toMcpHttpException(new SessionNotFound()).message).toBe(
                "Not Found",
            );
            expect(
                toMcpHttpException(new ClientIdTaken("assistant")).message,
            ).toBe("Client ID 'assistant' is already in use");
        } finally {
            vi.unstubAllEnvs();
        }
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
            expect(await text("conflict")).toBe(
                "Client ID 'assistant' is already in use",
            );
        });

        it("still hides other errors", async () => {
            expect(await text("crash")).toBe("Internal server error");
        });
    });
});
