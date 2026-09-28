import {
    type AuthResponse,
    AuthResponseSchema,
} from "../../presentations/dto/auth-response.dto.js";

export class PresentationResponseValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PresentationResponseValidationError";
    }
}

export class ParseAuthorizationResponse {
    execute(decrypted: unknown): AuthResponse {
        const parsed = AuthResponseSchema.safeParse(decrypted);
        if (!parsed.success) {
            throw new PresentationResponseValidationError(
                `Invalid authorization response: ${JSON.stringify(parsed.error.issues)}`,
            );
        }
        return parsed.data;
    }

    validateState(response: AuthResponse, expectedState: string): void {
        if (response.state && response.state !== expectedState) {
            throw new PresentationResponseValidationError(
                "State mismatch: response state does not match expected value",
            );
        }
    }
}
