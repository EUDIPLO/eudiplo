import type { ArgumentsHost } from "@nestjs/common";
import { ValidationError } from "@owf/identity-common";
import { JoseValidationError } from "@owf/jose";
import { describe, expect, it, vi } from "vitest";
import { ValidationErrorFilter } from "./validation-error.filter.js";

function host() {
    const json = vi.fn();
    const status = vi.fn().mockReturnValue({ json });
    const argumentsHost = {
        switchToHttp: () => ({
            getResponse: () => ({ status }),
            getRequest: () => ({
                method: "POST",
                path: "/token",
                url: "/token",
            }),
        }),
    } as unknown as ArgumentsHost;
    return { argumentsHost, status, json };
}

const issue = {
    severity: "error" as const,
    code: "missing_value",
    path: ["client_id"],
    message: "Required",
};

describe("ValidationErrorFilter", () => {
    it("answers a request that does not validate with 400 and its issues", () => {
        const { argumentsHost, status, json } = host();

        new ValidationErrorFilter().catch(
            new ValidationError("Invalid request", [issue]),
            argumentsHost,
        );

        expect(status).toHaveBeenCalledWith(400);
        expect(json).toHaveBeenCalledWith(
            expect.objectContaining({
                message: "Validation failed",
                errors: [issue],
            }),
        );
    });

    it("answers a validation error of a token check with 400, without its issues", () => {
        const { argumentsHost, status, json } = host();

        new ValidationErrorFilter().catch(
            new JoseValidationError("Invalid JWT claims", [
                {
                    ...issue,
                    code: "claim_value_mismatch",
                    path: ["sub"],
                    context: { expected: "session-1", actual: "other" },
                } as never,
            ]),
            argumentsHost,
        );

        expect(status).toHaveBeenCalledWith(400);
        expect(json).toHaveBeenCalledWith(
            expect.objectContaining({ message: "Validation failed" }),
        );
        expect(json.mock.calls[0][0]).not.toHaveProperty("errors");
    });
});
