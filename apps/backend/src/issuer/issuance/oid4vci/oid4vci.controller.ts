import {
    Body,
    Controller,
    Header,
    HttpCode,
    HttpException,
    HttpStatus,
    Param,
    Post,
    Req,
    Res,
} from "@nestjs/common";
import {
    ApiBody,
    ApiConsumes,
    ApiParam,
    ApiResponse,
    ApiTags,
} from "@nestjs/swagger";
import type {
    CreateCredentialResponseReturn,
    CredentialResponse,
    DeferredCredentialResponse,
} from "@openid4vc/openid4vci";
import type { Request, Response } from "express";
import { CredentialNotificationNotFound } from "./application/record-credential-notification.js";
import { DeferredCredentialRequestDto } from "./dto/deferred-credential-request.dto.js";
import { NotificationRequestDto } from "./dto/notification-request.dto.js";
import { CredentialRequestException } from "./exceptions/index.js";
import { NonceService } from "./nonce.service.js";
import { Oid4vciService } from "./oid4vci.service.js";
import type { Oid4vciRequestContext } from "./request-context.js";

/** Upper bound for an encrypted request body that no body parser read. */
const MAX_ENCRYPTED_REQUEST_BYTES = 10 * 1024 * 1024;

/** The unparsed encrypted request body exceeds the limit. */
class EncryptedRequestTooLarge extends Error {
    constructor() {
        super("Encrypted credential request body is too large");
    }
}

/**
 * Controller for handling OID4VCI (OpenID for Verifiable Credential Issuance) requests.
 */
@ApiTags("OID4VCI")
@ApiParam({ name: "tenantId", required: true })
@Controller("issuers/:tenantId/vci")
export class Oid4vciController {
    constructor(
        private readonly oid4vciService: Oid4vciService,
        private readonly nonceService: NonceService,
    ) {}

    /**
     * Endpoint to issue credentials
     * @param req
     * @param res
     * @param tenantId
     * @returns
     */
    @Post("credential")
    @HttpCode(HttpStatus.OK)
    async credential(
        @Req() req: Request,
        @Res({ passthrough: true }) res: Response,
        @Param("tenantId") tenantId: string,
    ): Promise<CredentialResponse | DeferredCredentialResponse | string> {
        const requestContext = await this.toRequestContext(req);
        return this.oid4vciService.getCredential(requestContext, tenantId).then(
            (result) => {
                // Check if this is a deferred response (has non-null transaction_id)
                if ("transaction_id" in result && result.transaction_id) {
                    res.status(HttpStatus.ACCEPTED);
                    return result;
                }

                const credentialResult =
                    result as CreateCredentialResponseReturn;

                // If the response is encrypted, return the JWE string directly
                // See: https://openid.net/specs/openid-4-verifiable-credential-issuance-1_0.html#name-credential-response
                if (credentialResult.credentialResponseJwt) {
                    res.setHeader("Content-Type", "application/jwt");
                    return credentialResult.credentialResponseJwt;
                }

                return credentialResult.credentialResponse;
            },
            (err) => {
                console.log(err);
                // Re-throw if already a spec-compliant CredentialRequestException
                if (err instanceof CredentialRequestException) {
                    throw err;
                }

                const resourceAuthError = toResourceAuthError(err, res);
                if (resourceAuthError) throw resourceAuthError;

                // Wrap other errors according to OID4VCI spec Section 8.3.1.2
                throw new CredentialRequestException(
                    "invalid_credential_request",
                    err.message,
                );
            },
        );
    }

    private async toRequestContext(
        req: Request,
    ): Promise<Oid4vciRequestContext> {
        const rawBody = req.body as
            | Record<string, unknown>
            | string
            | undefined;
        const contentType = (req.headers["content-type"] ?? "").toLowerCase();
        const isJwtContentType =
            contentType.startsWith("application/jwt") ||
            contentType.startsWith(
                "application/openid4vci-credential-request+jwt",
            );

        let body = rawBody;
        if (isJwtContentType || typeof rawBody === "string") {
            if (typeof rawBody !== "string") {
                try {
                    body = await new Promise<string>((resolve, reject) => {
                        const chunks: Buffer[] = [];
                        let size = 0;
                        req.on("data", (chunk: Buffer) => {
                            size += chunk.length;
                            // Same limit as the body parsers in bootstrap.ts.
                            if (size > MAX_ENCRYPTED_REQUEST_BYTES) {
                                req.destroy();
                                reject(new EncryptedRequestTooLarge());
                                return;
                            }
                            chunks.push(chunk);
                        });
                        req.on("end", () =>
                            resolve(Buffer.concat(chunks).toString("utf8")),
                        );
                        req.on("error", reject);
                    });
                } catch (error) {
                    throw new CredentialRequestException(
                        "invalid_encryption_parameters",
                        error instanceof EncryptedRequestTooLarge
                            ? error.message
                            : "Failed to read encrypted credential request body",
                    );
                }
                if (!body) {
                    throw new CredentialRequestException(
                        "invalid_encryption_parameters",
                        "Encrypted credential request body is empty",
                    );
                }
            }
        }

        return {
            body,
            contentType,
            headers: req.headers,
            method: req.method,
            url: req.url,
        };
    }

    /**
     * Deferred Credential Endpoint
     *
     * According to OID4VCI Section 9, this endpoint is used by the wallet to poll
     * for credentials that were not immediately available. Like the credential
     * endpoint, it accepts an encrypted request (`application/jwt`) and
     * encrypts the response when the request carries
     * `credential_response_encryption`.
     *
     * @param req The request
     * @param tenantId The tenant ID
     * @returns The credential response if ready, or issuance_pending error
     */
    @Post("deferred_credential")
    @HttpCode(HttpStatus.OK)
    @ApiConsumes("application/json", "application/jwt")
    @ApiBody({
        type: DeferredCredentialRequestDto,
        description:
            "The deferred credential request as JSON, or as a JWE (`application/jwt`) encrypted to the key in `credential_request_encryption` of the issuer metadata.",
    })
    @ApiResponse({
        status: 200,
        description:
            "The credential as JSON, or as a JWE (`application/jwt`) when the encrypted request carries `credential_response_encryption`.",
        content: {
            "application/json": {},
            "application/jwt": { schema: { type: "string" } },
        },
    })
    @ApiResponse({
        status: 400,
        description:
            "OAuth error: `issuance_pending` (with `interval`), `invalid_transaction_id`, `invalid_credential_request` or `invalid_encryption_parameters`.",
    })
    async deferredCredential(
        @Req() req: Request,
        @Param("tenantId") tenantId: string,
        @Res({ passthrough: true }) res: Response,
    ): Promise<DeferredCredentialResponse | string> {
        const requestContext = await this.toRequestContext(req);
        return this.oid4vciService
            .getDeferredCredential(requestContext, tenantId)
            .then(
                (result) => {
                    if (result.deferredCredentialResponseJwt) {
                        res.setHeader("Content-Type", "application/jwt");
                        return result.deferredCredentialResponseJwt;
                    }
                    return result.deferredCredentialResponse;
                },
                (err) => {
                    throw toResourceAuthError(err, res) ?? err;
                },
            );
    }

    /**
     * Notification endpoint
     * @param body
     * @returns
     */
    @Post("notification")
    notifications(
        @Body() body: NotificationRequestDto,
        @Req() req: Request,
        @Param("tenantId") tenantId: string,
        @Res({ passthrough: true }) res: Response,
    ) {
        return this.oid4vciService
            .handleNotification(
                {
                    body: req.body,
                    contentType: req.headers["content-type"] ?? "",
                    headers: req.headers,
                    method: req.method,
                    url: req.url,
                },
                body,
                tenantId,
            )
            .catch((err) => {
                // OID4VCI Section 11.3 Notification Error Response
                if (err instanceof CredentialNotificationNotFound) {
                    throw new HttpException(
                        {
                            error: "invalid_notification_id",
                            error_description:
                                "The notification_id is invalid or does not belong to the access token",
                        },
                        HttpStatus.BAD_REQUEST,
                    );
                }
                throw toResourceAuthError(err, res) ?? err;
            });
    }

    @Post("nonce")
    @HttpCode(HttpStatus.OK)
    @Header("Cache-Control", "no-store")
    nonce(@Param("tenantId") tenantId: string) {
        //TODO: maybe also add it into the header, see https://openid.net/specs/openid-4-verifiable-credential-issuance-1_0.html#name-nonce-response
        return this.nonceService.issue(tenantId).then((nonce) => ({
            c_nonce: nonce,
        }));
    }
}

/**
 * Map an access-token or DPoP failure of a protected resource request to
 * RFC 6750 / RFC 9449 semantics: 401 `invalid_token` with `WWW-Authenticate`.
 * Returns undefined for other errors.
 */
function toResourceAuthError(
    err: unknown,
    res: Response,
): HttpException | undefined {
    const resourceAuthError = err as
        | {
              message?: string;
              wwwAuthenticateHeaders?: Array<{ scheme?: string }>;
          }
        | undefined;
    if (
        !Array.isArray(resourceAuthError?.wwwAuthenticateHeaders) ||
        resourceAuthError.wwwAuthenticateHeaders.length === 0
    ) {
        return undefined;
    }
    const wwwAuthenticateValue = resourceAuthError.wwwAuthenticateHeaders
        .map((header) => header.scheme)
        .filter((scheme): scheme is string => Boolean(scheme))
        .join(", ");
    if (wwwAuthenticateValue) {
        res.setHeader("WWW-Authenticate", wwwAuthenticateValue);
    }
    return new HttpException(
        {
            error: "invalid_token",
            error_description:
                resourceAuthError.message ?? "Access token validation failed",
        },
        HttpStatus.UNAUTHORIZED,
    );
}
