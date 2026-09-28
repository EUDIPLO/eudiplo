import {
    Body,
    Controller,
    HttpCode,
    HttpStatus,
    NotFoundException,
    Param,
    Post,
} from "@nestjs/common";
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { Role } from "../../../auth/roles/role.enum.js";
import { Secured } from "../../../auth/secure.decorator.js";
import { Token, TokenPayload } from "../../../auth/token.decorator.js";
import { CompleteDeferredCredential } from "./application/complete-deferred-credential.js";
import { FailDeferredCredential } from "./application/fail-deferred-credential.js";
import {
    CompleteDeferredDto,
    DeferredOperationResponse,
    FailDeferredDto,
} from "./dto/complete-deferred.dto.js";

@ApiTags("Issuer")
@Secured([Role.IssuanceOffer])
@Controller("issuer/deferred")
export class DeferredController {
    constructor(
        private readonly completeDeferredCredential: CompleteDeferredCredential,
        private readonly failDeferredCredential: FailDeferredCredential,
    ) {}

    /**
     * Complete a deferred credential transaction by providing the claims.
     * This will generate the credential and mark it as ready for retrieval.
     *
     * @param transactionId The transaction ID returned when issuance was deferred
     * @param body The claims to include in the credential
     * @param user The authenticated user
     * @returns The updated transaction status
     */
    @ApiOperation({
        summary: "Complete a deferred credential transaction",
        description:
            "Completes a pending deferred credential transaction by providing the claims. " +
            "The credential will be generated and marked as ready for wallet retrieval.",
    })
    @ApiBody({
        type: CompleteDeferredDto,
        examples: {
            example: {
                summary: "Complete with claims",
                value: {
                    claims: {
                        given_name: "John",
                        family_name: "Doe",
                        birthdate: "1990-01-15",
                    },
                },
            },
        },
    })
    @ApiResponse({
        status: 200,
        description: "Transaction completed successfully",
        type: DeferredOperationResponse,
    })
    @ApiResponse({
        status: 404,
        description: "Transaction not found",
    })
    @HttpCode(HttpStatus.OK)
    @Post(":transactionId/complete")
    async completeDeferred(
        @Param("transactionId") transactionId: string,
        @Body() body: CompleteDeferredDto,
        @Token() user: TokenPayload,
    ): Promise<DeferredOperationResponse> {
        const transaction = await this.completeDeferredCredential.execute({
            tenantId: user.entity!.id,
            transactionId,
            claims: body.claims,
        });

        if (!transaction) {
            throw new NotFoundException(
                `Deferred transaction not found: ${transactionId}`,
            );
        }

        return {
            transactionId: transaction.transactionId,
            status: transaction.status,
            message: "Credential generated and ready for retrieval",
        };
    }

    /**
     * Fail a deferred credential transaction.
     * The wallet will receive an error when it tries to retrieve the credential.
     *
     * @param transactionId The transaction ID returned when issuance was deferred
     * @param body Optional error message
     * @param user The authenticated user
     * @returns The updated transaction status
     */
    @ApiOperation({
        summary: "Fail a deferred credential transaction",
        description:
            "Marks a deferred credential transaction as failed. " +
            "The wallet will receive an invalid_transaction_id error when attempting retrieval.",
    })
    @ApiBody({
        type: FailDeferredDto,
        examples: {
            example: {
                summary: "Fail with error message",
                value: {
                    error: "Identity verification failed",
                },
            },
        },
    })
    @ApiResponse({
        status: 200,
        description: "Transaction marked as failed",
        type: DeferredOperationResponse,
    })
    @ApiResponse({
        status: 404,
        description: "Transaction not found",
    })
    @HttpCode(HttpStatus.OK)
    @Post(":transactionId/fail")
    async failDeferred(
        @Param("transactionId") transactionId: string,
        @Body() body: FailDeferredDto,
        @Token() user: TokenPayload,
    ): Promise<DeferredOperationResponse> {
        const transaction = await this.failDeferredCredential.execute(
            user.entity!.id,
            transactionId,
            body.error,
        );

        if (!transaction) {
            throw new NotFoundException(
                `Deferred transaction not found: ${transactionId}`,
            );
        }

        return {
            transactionId: transaction.transactionId,
            status: transaction.status,
            message: body.error || "Transaction marked as failed",
        };
    }
}
