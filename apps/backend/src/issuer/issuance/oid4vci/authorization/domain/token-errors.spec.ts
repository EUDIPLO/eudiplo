import { describe, expect, it } from "vitest";
import { OAuthError } from "./oauth-error.js";
import {
    describeLibraryError,
    describeMalformedTokenRequest,
    oauthErrorFromLibrary,
    toTokenErrorCode,
} from "./token-errors.js";

describe("toTokenErrorCode", () => {
    it.each([
        [undefined, "invalid_request"],
        ["invalid_grant", "invalid_grant"],
        ["invalid_client", "invalid_client"],
        ["invalid_dpop_proof", "invalid_dpop_proof"],
        ["invalid_tx_code", "invalid_tx_code"],
        ["wrong_tx_code", "invalid_tx_code"],
        ["transaction_mismatch", "invalid_tx_code"],
        ["expired pre-authorized code", "invalid_grant"],
        ["pre_authorized_code_mismatch", "invalid_grant"],
        ["unsupported_grant_type", "invalid_request"],
    ])("maps %s to %s", (input, expected) => {
        expect(toTokenErrorCode(input)).toBe(expected);
    });
});

describe("describeLibraryError", () => {
    it("prefers errorResponse, then error_description, message and cause", () => {
        expect(
            describeLibraryError({
                errorResponse: { error_description: "a" },
                error_description: "b",
                message: "c",
            }),
        ).toBe("a");
        expect(
            describeLibraryError({ error_description: "b", message: "c" }),
        ).toBe("b");
        expect(
            describeLibraryError({ message: " ", cause: { message: "d" } }),
        ).toBe("d");
        expect(describeLibraryError("plain")).toBe("plain");
        expect(describeLibraryError({})).toBeUndefined();
        expect(describeLibraryError(42)).toBeUndefined();
    });
});

describe("describeMalformedTokenRequest", () => {
    it.each([
        [undefined, "Malformed token request body"],
        [{}, "Missing required parameter: grant_type"],
        [
            { grant_type: "authorization_code" },
            "Missing required parameter: code",
        ],
        [
            {
                grant_type:
                    "urn:ietf:params:oauth:grant-type:pre-authorized_code",
            },
            "Missing required parameter: pre-authorized_code",
        ],
        [
            { grant_type: "refresh_token" },
            "Missing required parameter: refresh_token",
        ],
        [
            { grant_type: "password" },
            "Invalid token request for grant_type: password",
        ],
    ])("describes %o", (body, expected) => {
        expect(describeMalformedTokenRequest(body)).toBe(expected);
    });
});

describe("oauthErrorFromLibrary", () => {
    it("uses errorResponse.error and passes OAuthErrors through", () => {
        const error = oauthErrorFromLibrary({
            errorResponse: { error: "invalid_grant", error_description: "x" },
        });
        expect(error).toMatchObject({
            code: "invalid_grant",
            description: "x",
            clientAuthenticationFailed: false,
        });
        expect(oauthErrorFromLibrary(error)).toBe(error);
        expect(oauthErrorFromLibrary(undefined)).toMatchObject({
            code: "invalid_request",
            description: undefined,
        });
    });

    it("is an Error with the description as message", () => {
        const error = new OAuthError("invalid_client", "nope", {
            clientAuthenticationFailed: true,
        });
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toBe("nope");
        expect(error.clientAuthenticationFailed).toBe(true);
    });
});
