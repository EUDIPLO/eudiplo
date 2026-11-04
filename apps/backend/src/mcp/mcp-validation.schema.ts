import Joi from "joi";

export const MCP_VALIDATION_SCHEMA: Joi.ObjectSchema = Joi.object({
    MCP_ENABLED: Joi.boolean()
        .default(false)
        .description(
            "Serve the experimental MCP (Model Context Protocol) endpoint at `/api/mcp`, so AI assistants can read a tenant's configurations and sessions. It accepts the access tokens of the management API, and every tool needs the roles of the matching management endpoint",
        )
        .meta({ group: "mcp", order: 10 }),
});

/**
 * Whether `MCP_ENABLED` turns the MCP endpoint on. Read from the environment
 * when the application module is assembled, since the endpoint is a route.
 * Joi accepts `true` and `false` in any case and refuses other values.
 */
export function isMcpEnabled(env: NodeJS.ProcessEnv): boolean {
    return env.MCP_ENABLED?.toLowerCase() === "true";
}
