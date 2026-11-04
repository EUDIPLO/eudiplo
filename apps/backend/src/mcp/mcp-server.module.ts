import { Module, UseGuards } from "@nestjs/common";
import { McpModule } from "@nestjs/mcp";
import { ApiExcludeController } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/auth.guard.js";
import { McpToolsModule } from "./mcp-tools.module.js";

const INSTRUCTIONS =
    "EUDIPLO issues and verifies EUDI Wallet credentials over OID4VCI and OID4VP for several tenants. These tools only read, and only the data of the tenant of the access token. Call get_caller first: its roles decide which tools work. Sessions come as summaries, without claims or credentials.";

/**
 * The MCP endpoint at `/api/mcp`, imported only with `MCP_ENABLED`. It
 * checks access tokens with the JWT guard of the management API, so a token
 * is accepted, rejected or ended exactly as there; each tool then checks the
 * roles of the matching management endpoint.
 */
@Module({
    imports: [
        McpModule.forRoot({
            name: "eudiplo",
            title: "EUDIPLO",
            version: process.env.VERSION ?? "main",
            websiteUrl: "https://docs.eudiplo.dev/",
            instructions: INSTRUCTIONS,
            include: [McpToolsModule],
            path: "mcp",
            decorators: [ApiExcludeController(), UseGuards(JwtAuthGuard)],
        }),
        McpToolsModule,
    ],
})
export class McpServerModule {}
