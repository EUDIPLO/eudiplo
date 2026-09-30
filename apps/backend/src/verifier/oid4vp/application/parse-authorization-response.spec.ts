import { describe, expect, it } from "vitest";
import {
    ParseAuthorizationResponse,
    PresentationResponseValidationError,
} from "./parse-authorization-response.js";

describe("ParseAuthorizationResponse", () => {
    const useCase = new ParseAuthorizationResponse();
    it("parses responses separately from state validation", () => {
        const response = useCase.execute({
            vp_token: { credential: ["vp"] },
            state: "wallet-state",
        });
        expect(response.state).toBe("wallet-state");
        expect(() =>
            useCase.validateState(response, "wallet-state"),
        ).not.toThrow();
        expect(() =>
            useCase.validateState(
                useCase.execute({ vp_token: { credential: ["vp"] } }),
                "wallet-state",
            ),
        ).not.toThrow();
    });
    it("rejects invalid schemas and mismatched states neutrally", () => {
        expect(() => useCase.execute({})).toThrow(
            PresentationResponseValidationError,
        );
        expect(() => useCase.execute({ vp_token: { mdl: [] } })).toThrow(
            PresentationResponseValidationError,
        );
        const response = useCase.execute({
            vp_token: { credential: ["vp"] },
            state: "other",
        });
        expect(() => useCase.validateState(response, "wallet-state")).toThrow(
            "State mismatch",
        );
    });
});
