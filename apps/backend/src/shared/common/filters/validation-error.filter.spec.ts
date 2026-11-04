import { type ArgumentsHost, Logger } from "@nestjs/common";
import { ValidationError } from "@openid4vc/utils";
import { describe, expect, it, vi } from "vitest";
import { ValidationErrorFilter } from "./validation-error.filter.js";

describe("ValidationErrorFilter", () => {
    it("answers HTTP requests with 400", () => {
        vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
        const json = vi.fn();
        const status = vi.fn().mockReturnValue({ json });
        const host = {
            getType: () => "http",
            switchToHttp: () => ({ getResponse: () => ({ status }) }),
        } as unknown as ArgumentsHost;

        new ValidationErrorFilter().catch(new ValidationError("bad"), host);

        expect(status).toHaveBeenCalledWith(400);
        expect(json.mock.calls[0][0]).toMatchObject({
            message: "Validation failed",
        });
        vi.restoreAllMocks();
    });

    it("leaves MCP tool calls to the MCP module", () => {
        const switchToHttp = vi.fn();
        const host = {
            getType: () => "mcp",
            switchToHttp,
        } as unknown as ArgumentsHost;

        expect(
            new ValidationErrorFilter().catch(new ValidationError("bad"), host),
        ).toBeUndefined();
        expect(switchToHttp).not.toHaveBeenCalled();
    });
});
