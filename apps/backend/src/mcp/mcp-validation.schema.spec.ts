import { describe, expect, it } from "vitest";
import {
    isMcpEnabled,
    MCP_VALIDATION_SCHEMA,
} from "./mcp-validation.schema.js";

describe("MCP_ENABLED", () => {
    it("is off by default", () => {
        const { value } = MCP_VALIDATION_SCHEMA.validate({});
        expect(value.MCP_ENABLED).toBe(false);
        expect(isMcpEnabled({})).toBe(false);
    });

    it.each(["true", "TRUE", "True"])(
        "turns the endpoint on with %s",
        (raw) => {
            expect(
                MCP_VALIDATION_SCHEMA.validate({ MCP_ENABLED: raw }).value,
            ).toEqual({ MCP_ENABLED: true });
            expect(isMcpEnabled({ MCP_ENABLED: raw })).toBe(true);
        },
    );

    it("keeps the endpoint off with false", () => {
        expect(isMcpEnabled({ MCP_ENABLED: "false" })).toBe(false);
    });

    it("refuses other values at startup, so none of them turns it on unnoticed", () => {
        expect(
            MCP_VALIDATION_SCHEMA.validate({ MCP_ENABLED: "yes" }).error,
        ).toBeDefined();
    });
});
