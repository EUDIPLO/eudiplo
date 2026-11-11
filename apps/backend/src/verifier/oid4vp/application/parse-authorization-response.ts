import {
    parseDcqlVpToken,
    parseOpenid4VpAuthorizationResponsePayload,
} from "@openid4vc/openid4vp";
import type { AuthResponseData } from "../../presentations/domain/auth-response.js";

export class PresentationResponseValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PresentationResponseValidationError";
    }
}

export class ParseAuthorizationResponse {
    /**
     * Parses a decrypted authorization response with `@openid4vc/openid4vp`.
     * Response parameters the verifier does not use are ignored. Like the
     * library, it accepts a `vp_token` encoded as a JSON string and a single
     * presentation instead of an array. Every presentation must be a string,
     * the encoding of the SD-JWT VC and mdoc formats the verifier supports.
     * @throws PresentationResponseValidationError when the response is no
     *   authorization response with a DCQL `vp_token`
     */
    execute(decrypted: unknown): AuthResponseData {
        if (!decrypted || typeof decrypted !== "object") {
            throw new PresentationResponseValidationError(
                "Invalid authorization response: expected a JSON object",
            );
        }
        let state: string | undefined;
        let presentations: Record<string, unknown[]>;
        try {
            const payload = parseOpenid4VpAuthorizationResponsePayload(
                decrypted as Record<string, unknown>,
            );
            state = payload.state;
            presentations = parseDcqlVpToken(payload.vp_token);
        } catch (error) {
            throw new PresentationResponseValidationError(
                `Invalid authorization response: ${(error as Error).message}`,
            );
        }

        const vp_token: Record<string, string[]> = {};
        for (const [credentialId, values] of Object.entries(presentations)) {
            if (!values.every((value) => typeof value === "string")) {
                throw new PresentationResponseValidationError(
                    `Invalid authorization response: the presentations of ${credentialId} must be strings`,
                );
            }
            vp_token[credentialId] = values as string[];
        }
        return { vp_token, state };
    }

    /**
     * A response to a request with `state` returns it unchanged (RFC 6749
     * §4.1.2, which OID4VP 1.0 §8.1 builds on). Requests over the DC API
     * carry no `state`, so `expectedState` is undefined and nothing is
     * checked.
     * @throws PresentationResponseValidationError when the state is missing
     *   or differs
     */
    validateState(
        response: AuthResponseData,
        expectedState: string | undefined,
    ): void {
        if (expectedState === undefined) {
            return;
        }
        if (response.state === undefined) {
            throw new PresentationResponseValidationError(
                "State missing: the response does not return the state of the request",
            );
        }
        if (response.state !== expectedState) {
            throw new PresentationResponseValidationError(
                "State mismatch: response state does not match expected value",
            );
        }
    }
}
