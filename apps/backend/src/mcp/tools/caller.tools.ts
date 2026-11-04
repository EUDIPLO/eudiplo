import { Injectable } from "@nestjs/common";
import { type McpContext, Tool } from "@nestjs/mcp";
import { allRoles, isRole } from "../../auth/roles/role.enum.js";
import { callerOf, type McpRequest } from "../mcp-caller.js";
import { McpSecured } from "../mcp-secured.decorator.js";

@Injectable()
export class CallerTools {
    @Tool({
        name: "get_caller",
        title: "Get caller",
        description:
            "Returns the tenant, the client and the EUDIPLO roles of the access token this MCP client uses, and the EUDIPLO version. The roles decide which other tools work: sessions need issuance:offer, presentation:request or sessions:read, credential configurations issuance:manage, presentation configurations presentation:manage or presentation:request.",
        annotations: { readOnlyHint: true, openWorldHint: false },
    })
    @McpSecured(allRoles)
    getCaller(_input: unknown, context: McpContext<McpRequest>) {
        const token = callerOf(context);
        return {
            clientId:
                token.client?.clientId ??
                token.authorizedParty ??
                token.subject ??
                null,
            tenant: token.entity
                ? { id: token.entity.id, name: token.entity.name }
                : null,
            roles: token.roles.filter(isRole),
            version: process.env.VERSION ?? "main",
        };
    }
}
