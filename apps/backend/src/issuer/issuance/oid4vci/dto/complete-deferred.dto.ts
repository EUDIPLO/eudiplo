import { ApiProperty } from "@nestjs/swagger";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import { DeferredTransactionStatus } from "../domain/deferred-transaction-status.js";

const CompleteDeferredSchema = z
    .object({
        claims: z.record(z.string(), z.unknown()),
    })
    .strict();

const FailDeferredSchema = z
    .object({
        error: z.string().optional(),
    })
    .strict();

/**
 * DTO for completing a deferred transaction
 */
export class CompleteDeferredDto extends createZodDto(CompleteDeferredSchema) {
    /**
     * Claims to include in the credential.
     * The structure should match the credential configuration's expected claims.
     */
    @ApiProperty({
        description:
            "Claims to include in the credential. The structure should match the credential configuration's expected claims.",
        example: {
            given_name: "John",
            family_name: "Doe",
            birthdate: "1990-01-15",
        },
    })
    claims!: Record<string, unknown>;
}

/**
 * DTO for failing a deferred transaction
 */
export class FailDeferredDto extends createZodDto(FailDeferredSchema) {
    /**
     * Optional error message explaining why the issuance failed
     */
    @ApiProperty({
        description:
            "Optional error message explaining why the issuance failed",
        required: false,
        example: "Identity verification failed",
    })
    error?: string;
}

/**
 * Response for deferred transaction operations
 */
export class DeferredOperationResponse {
    /**
     * The transaction ID
     */
    @ApiProperty({
        description: "The transaction ID",
    })
    transactionId!: string;

    /**
     * The new status of the transaction
     */
    @ApiProperty({
        description: "The new status of the transaction",
        enum: DeferredTransactionStatus,
    })
    status!: DeferredTransactionStatus;

    /**
     * Optional message
     */
    @ApiProperty({
        description: "Optional message",
        required: false,
    })
    message?: string;
}
