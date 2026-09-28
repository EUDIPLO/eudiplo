import { describe, expect, it } from "vitest";
import { OAuthError } from "../authorization/domain/oauth-error.js";
import { tokenErrorResponse } from "./token-error.exception.js";

describe("tokenErrorResponse", () => {
    it("maps an OAuthError to a 400 OAuth error body", () => {
        const response = tokenErrorResponse(
            new OAuthError("invalid_grant", "PKCE verification failed"),
        );
        expect(response.getStatus()).toBe(400);
        expect(response.getResponse()).toEqual({
            error: "invalid_grant",
            error_description: "PKCE verification failed",
        });
    });

    it("answers failed client authentication with 401", () => {
        const response = tokenErrorResponse(
            new OAuthError("invalid_client", "Wallet attestation is required", {
                clientAuthenticationFailed: true,
            }),
        );
        expect(response.getStatus()).toBe(401);
        expect(response.getResponse()).toEqual({
            error: "invalid_client",
            error_description: "Wallet attestation is required",
        });
    });

    it("omits a missing description and sanitizes forbidden characters", () => {
        expect(
            tokenErrorResponse(new OAuthError("invalid_request")).getResponse(),
        ).toEqual({ error: "invalid_request" });
        expect(
            tokenErrorResponse(
                new OAuthError("invalid_dpop_proof", 'bad "proof"\n\tline'),
            ).getResponse(),
        ).toEqual({
            error: "invalid_dpop_proof",
            error_description: "bad proof line",
        });
    });
});
