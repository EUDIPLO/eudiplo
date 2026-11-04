import {
    type INestApplication,
    Injectable,
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
    const missingSession = new SessionNotFound();
    const missingEntity = new EntityNotFoundError("ClientEntity", {
        clientId: "app",
    });
    const taken = new ClientIdTaken("assistant");

    it.each([
        ["test", missingSession, 404, "Session not found"],
        ["test", missingEntity, 404, missingEntity.message],
        ["test", taken, 409, "Client ID 'assistant' is already in use"],
        // Only the message reaches an MCP client: it names the status where
        // the REST API's message is generic.
        ["production", missingSession, 404, "Not Found"],
        ["production", missingEntity, 404, "Not Found"],
        ["production", taken, 409, "Client ID 'assistant' is already in use"],
    ] as const)(
        "answers with NODE_ENV=%s and %o: %i %s",
        (nodeEnv, error, status, message) => {
            vi.stubEnv("NODE_ENV", nodeEnv);
            try {
                const mcp = toMcpHttpException(error);
                expect(mcp.getStatus()).toBe(status);
                expect(mcp.message).toBe(message);
            } finally {
                vi.unstubAllEnvs();
            }
        },
    );

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
