import { BadRequestException } from "@nestjs/common";

/**
 * Exception thrown when a presentation response does not satisfy the DCQL query requirements.
 * This includes missing credentials, missing claims, claims without a requested value,
 * or unsatisfied credential sets.
 */
export class IncompletePresentationException extends BadRequestException {
    constructor(
        message: string,
        public readonly details?: {
            missingCredentials?: string[];
            missingClaims?: Record<string, string[]>;
            mismatchedClaims?: Record<string, string[]>;
            unsatisfiedCredentialSets?: number[];
        },
        /** Stable failure code for the session outcome (e.g. `claim_value_mismatch`). */
        public readonly code?: string,
    ) {
        super({
            message,
            error: "Incomplete Presentation",
            details,
        });
    }
}
