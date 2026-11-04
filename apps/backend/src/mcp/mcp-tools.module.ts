import { Module } from "@nestjs/common";
import { CredentialConfigModule } from "../issuer/configuration/credentials/credential-config.module.js";
import { SessionModule } from "../session/session.module.js";
import { PresentationsModule } from "../verifier/presentations/presentations.module.js";
import { CallerTools } from "./tools/caller.tools.js";
import { ConfigurationTools } from "./tools/configuration.tools.js";
import { SessionTools } from "./tools/session.tools.js";

/** The providers whose methods are the MCP tools; only these are served. */
@Module({
    imports: [CredentialConfigModule, PresentationsModule, SessionModule],
    providers: [CallerTools, ConfigurationTools, SessionTools],
})
export class McpToolsModule {}
