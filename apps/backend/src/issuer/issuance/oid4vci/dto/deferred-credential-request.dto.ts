import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

const DeferredCredentialRequestSchema = z.object({
    transaction_id: z.string().min(1),
    credential_response_encryption: z
        .object({
            jwk: z.record(z.string(), z.unknown()),
            enc: z.string(),
            zip: z.string().optional(),
        })
        .optional(),
});

/**
 * DTO for the Deferred Credential Request.
 *
 * According to OID4VCI Section 9.1, the request MUST include a `transaction_id`
 * that was previously returned by the Credential Endpoint. Only used to
 * describe the plain request in OpenAPI: the endpoint hands the body to
 * `parseDeferredCredentialRequest` of `@openid4vc/openid4vci`, which also
 * accepts an encrypted request and ignores unknown members.
 *
 * @see https://openid.net/specs/openid-4-verifiable-credential-issuance-1_0.html#name-deferred-credential-request
 */
export class DeferredCredentialRequestDto extends createZodDto(
    DeferredCredentialRequestSchema,
) {
    /**
     * The transaction identifier returned by the Credential Endpoint.
     */
    @ApiProperty({
        description:
            "The transaction identifier previously returned by the Credential Endpoint",
        example: "8xLOxBtZp8",
    })
    transaction_id!: string;

    /**
     * Requests an encrypted response. Accepted only in an encrypted request.
     */
    @ApiPropertyOptional({
        description:
            "Requests an encrypted response (`jwk` with `alg`, `enc`, optional `zip`), as in the credential request. Accepted only when the request itself is encrypted (`application/jwt`).",
    })
    credential_response_encryption?: {
        jwk: Record<string, unknown>;
        enc: string;
        zip?: string;
    };
}
