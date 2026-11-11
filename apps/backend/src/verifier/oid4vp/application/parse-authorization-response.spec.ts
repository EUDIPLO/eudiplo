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
        expect(response).toEqual({
            vp_token: { credential: ["vp"] },
            state: "wallet-state",
        });
        expect(() =>
            useCase.validateState(response, "wallet-state"),
        ).not.toThrow();
    });
    // OID4VP 1.0 Section 8.1: the client MUST ignore unrecognized parameters.
    it("ignores response parameters it does not use", () => {
        expect(
            useCase.execute({
                vp_token: { credential: ["vp"] },
                iss: "https://wallet.example",
                exp: 1,
                foo: "bar",
            }),
        ).toEqual({ vp_token: { credential: ["vp"] }, state: undefined });
    });
    it("wraps a single presentation in an array", () => {
        expect(useCase.execute({ vp_token: { credential: "vp" } })).toEqual({
            vp_token: { credential: ["vp"] },
            state: undefined,
        });
    });
    it("accepts a vp_token encoded as a JSON string", () => {
        expect(
            useCase.execute({
                vp_token: JSON.stringify({ credential: ["vp"] }),
            }),
        ).toEqual({ vp_token: { credential: ["vp"] }, state: undefined });
    });
    it.each([
        ["no object", "vp_token"],
        ["no vp_token", {}],
        ["an empty presentation array", { vp_token: { mdl: [] } }],
        ["a vp_token string", { vp_token: "vp" }],
        ["a vp_token array", { vp_token: ["vp"] }],
        ["an object presentation", { vp_token: { mdl: [{ proof: {} }] } }],
        [
            "an error next to the vp_token",
            { vp_token: { mdl: ["vp"] }, error: "access_denied" },
        ],
    ])("rejects a response with %s", (_, response) => {
        expect(() => useCase.execute(response)).toThrow(
            PresentationResponseValidationError,
        );
    });
    it("rejects mismatched and missing states", () => {
        const response = useCase.execute({
            vp_token: { credential: ["vp"] },
            state: "other",
        });
        expect(() => useCase.validateState(response, "wallet-state")).toThrow(
            "State mismatch",
        );
        expect(() =>
            useCase.validateState(
                useCase.execute({ vp_token: { credential: ["vp"] } }),
                "wallet-state",
            ),
        ).toThrow("State missing");
    });
    it("does not check the state when the request had none", () => {
        expect(() =>
            useCase.validateState(
                useCase.execute({ vp_token: { credential: ["vp"] } }),
                undefined,
            ),
        ).not.toThrow();
    });

    it("accepts and strips additional authorization response parameters", () => {
        const response = useCase.execute({
            vp_token: { credential: ["vp"] },
            state: "wallet-state",
            nonce: "wallet-nonce",
            nbf: 1760000000,
            jti: "wallet-response-id",
        });

        expect(response).toEqual({
            vp_token: { credential: ["vp"] },
            state: "wallet-state",
        });
    });
});
