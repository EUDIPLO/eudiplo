import {
    type AuthResponseData,
    AuthResponseSchema,
} from "../../presentations/domain/auth-response.js";

export class PresentationResponseValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PresentationResponseValidationError";
    }
}

export class ParseAuthorizationResponse {
    execute(decrypted: unknown): AuthResponseData {
        const parsed = AuthResponseSchema.safeParse(decrypted);
        if (!parsed.success) {
            throw new PresentationResponseValidationError(
                `Invalid authorization response: ${JSON.stringify(parsed.error.issues)}`,
            );
        }
        return parsed.data;
    }

    validateState(response: AuthResponseData, expectedState: string): void {
        if (response.state && response.state !== expectedState) {
            throw new PresentationResponseValidationError(
                "State mismatch: response state does not match expected value",
            );
        }
    }
}
