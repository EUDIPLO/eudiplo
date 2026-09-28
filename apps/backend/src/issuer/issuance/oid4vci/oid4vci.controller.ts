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
import { ApiParam, ApiTags } from "@nestjs/swagger";
import type {
    CreateCredentialResponseReturn,
    CredentialResponse,
    DeferredCredentialResponse,
} from "@openid4vc/openid4vci";
import type { Request, Response } from "express";
import { DeferredCredentialRequestDto } from "./dto/deferred-credential-request.dto.js";
import { NotificationRequestDto } from "./dto/notification-request.dto.js";
import { CredentialRequestException } from "./exceptions/index.js";
import { Oid4vciService } from "./oid4vci.service.js";
import type { Oid4vciRequestContext } from "./request-context.js";

/**
 * Controller for handling OID4VCI (OpenID for Verifiable Credential Issuance) requests.
 */
@ApiTags("OID4VCI")
@ApiParam({ name: "tenantId", required: true })
@Controller("issuers/:tenantId/vci")
export class Oid4vciController {
    constructor(private readonly oid4vciService: Oid4vciService) {}

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

                // Preserve OAuth2 resource auth semantics (e.g. DPoP scheme
                // validation) so conformance tests can assert 401 +
                // WWW-Authenticate correctly.
                const resourceAuthError = err as
                    | {
                          message?: string;
                          wwwAuthenticateHeaders?: Array<{
                              scheme?: string;
                          }>;
                      }
                    | undefined;

                if (
                    Array.isArray(resourceAuthError?.wwwAuthenticateHeaders) &&
                    resourceAuthError.wwwAuthenticateHeaders.length > 0
                ) {
                    const wwwAuthenticateValue =
                        resourceAuthError.wwwAuthenticateHeaders
                            .map((header) => header.scheme)
                            .filter((scheme): scheme is string =>
                                Boolean(scheme),
                            )
                            .join(", ");

                    if (wwwAuthenticateValue) {
                        res.setHeader("WWW-Authenticate", wwwAuthenticateValue);
                    }

                    throw new HttpException(
                        {
                            error: "invalid_token",
                            error_description:
                                resourceAuthError.message ??
                                "Access token validation failed",
                        },
                        HttpStatus.UNAUTHORIZED,
                    );
                }

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
                        req.on("data", (chunk: Buffer) => chunks.push(chunk));
                        req.on("end", () =>
                            resolve(Buffer.concat(chunks).toString("utf8")),
                        );
                        req.on("error", reject);
                    });
                } catch {
                    throw new CredentialRequestException(
                        "invalid_encryption_parameters",
                        "Failed to read encrypted credential request body",
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
     * for credentials that were not immediately available.
     *
     * @param req The request
     * @param body The deferred credential request containing transaction_id
     * @param tenantId The tenant ID
     * @returns The credential response if ready, or issuance_pending error
     */
    @Post("deferred_credential")
    @HttpCode(HttpStatus.OK)
    deferredCredential(
        @Req() req: Request,
        @Body() body: DeferredCredentialRequestDto,
        @Param("tenantId") tenantId: string,
    ): Promise<CredentialResponse> {
        return this.oid4vciService.getDeferredCredential(
            {
                body: req.body,
                contentType: req.headers["content-type"] ?? "",
                headers: req.headers,
                method: req.method,
                url: req.url,
            },
            body,
            tenantId,
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
    ) {
        return this.oid4vciService.handleNotification(
            {
                body: req.body,
                contentType: req.headers["content-type"] ?? "",
                headers: req.headers,
                method: req.method,
                url: req.url,
            },
            body,
            tenantId,
        );
    }

    @Post("nonce")
    @HttpCode(HttpStatus.OK)
    @Header("Cache-Control", "no-store")
    nonce(@Param("tenantId") tenantId: string) {
        //TODO: maybe also add it into the header, see https://openid.net/specs/openid-4-verifiable-credential-issuance-1_0.html#name-nonce-response
        return this.oid4vciService.nonceRequest(tenantId).then((nonce) => ({
            c_nonce: nonce,
        }));
    }
}
