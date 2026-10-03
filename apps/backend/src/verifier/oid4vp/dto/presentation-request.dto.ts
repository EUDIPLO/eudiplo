import { ApiExtraModels, ApiPropertyOptional } from "@nestjs/swagger";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import { WebhookConfig } from "../../../webhook/webhook.dto.js";
import { TransactionData } from "../../presentations/entities/presentation-config.entity.js";
import { TransactionDataSchema } from "../../presentations/schemas/presentation-config.schema.js";
import {
    ClientIdScheme,
    PresentationRequestSchema,
    ResponseType,
} from "./presentation-request.schema.js";

export { ClientIdScheme, ResponseType } from "./presentation-request.schema.js";

export type ResponseTypeValue =
    (typeof ResponseType)[keyof typeof ResponseType];
export type ClientIdSchemeValue =
    (typeof ClientIdScheme)[keyof typeof ClientIdScheme];

type PresentationRequestConstructor = new () => PresentationRequestData;

const PresentationRequestBase: PresentationRequestConstructor = createZodDto(
    PresentationRequestSchema,
) as PresentationRequestConstructor;

interface PresentationRequestData {
    response_type: ResponseTypeValue;
    requestId: string;
    webhook?: WebhookConfig;
    redirectUri?: string;
    expected_origin?: string;
    transaction_data?: z.infer<typeof TransactionDataSchema>[];
    skewSeconds?: number;
    clientIdScheme?: ClientIdSchemeValue;
    reference?: string;
}

/** DTO for the presentation request containing the response type and request ID. */
@ApiExtraModels(WebhookConfig, TransactionData)
export class PresentationRequest
    extends PresentationRequestBase
    implements PresentationRequestData
{
    /**
     * The type of response expected from the presentation request.
     */
    response_type!: ResponseTypeValue;

    /**
     * Identifier of the presentation configuration
     */
    requestId!: string;

    /**
     * Webhook configuration to receive the response.
     * If not provided, the configured webhook from the configuration will be used.
     */
    @ApiPropertyOptional({ type: () => WebhookConfig })
    webhook?: WebhookConfig;

    /**
     * Optional redirect URI to which the user-agent should be redirected after the presentation is completed.
     * You can use the `{sessionId}` placeholder in the URI, which will be replaced with the actual session ID.
     * @example "https://example.com/callback?session={sessionId}"
     */
    redirectUri?: string;

    /**
     * Optional expected browser origin for DC API key-binding audience.
     * Example: "http://localhost:8080"
     */
    expected_origin?: string;

    /**
     * Optional transaction data to include in the OID4VP request.
     * If provided, this will override the transaction_data from the presentation configuration.
     */
    @ApiPropertyOptional({ type: () => [TransactionData] })
    transaction_data?: z.infer<typeof TransactionDataSchema>[];

    /**
     * Optional clock skew tolerance for this presentation offer, in seconds.
     * If provided, this overrides the presentation configuration for the created session.
     */
    skewSeconds?: number;

    /**
     * Client identifier scheme for the OID4VP request. Defaults to x509_hash.
     */
    @ApiPropertyOptional({
        enum: ClientIdScheme,
        default: ClientIdScheme.X509_HASH,
    })
    clientIdScheme?: ClientIdSchemeValue;

    /**
     * Caller reference stored with the session, e.g. an order or case id.
     * Stored in plaintext and kept on anonymization: never put personal data here.
     * @example "order-4711"
     */
    reference?: string;
}

export type PresentationRequestOptions = Pick<
    PresentationRequestData,
    | "webhook"
    | "redirectUri"
    | "expected_origin"
    | "transaction_data"
    | "skewSeconds"
    | "clientIdScheme"
    | "reference"
> & {
    session?: string;
};
