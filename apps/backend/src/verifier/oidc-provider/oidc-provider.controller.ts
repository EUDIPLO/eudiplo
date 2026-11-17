import {
    Body,
    Controller,
    Get,
    Headers,
    HttpCode,
    HttpStatus,
    Inject,
    Logger,
    NotFoundException,
    Param,
    Post,
    Query,
    Res,
} from "@nestjs/common";
import {
    ApiBody,
    ApiConsumes,
    ApiOperation,
    ApiParam,
    ApiResponse,
    ApiTags,
} from "@nestjs/swagger";
import type { Response } from "express";
import { Public } from "../../auth/public.decorator.js";
import { AuthenticateOidcClient } from "./application/authenticate-client.js";
import {
    BuildOidcDiscovery,
    OidcProviderNotEnabled,
} from "./application/build-oidc-discovery.js";
import { FinishSignIn, type SignInStep } from "./application/finish-sign-in.js";
import { PushAuthorizationRequest } from "./application/push-authorization-request.js";
import { RedeemAuthorizationCode } from "./application/redeem-authorization-code.js";
import { StartSignIn } from "./application/start-sign-in.js";
import { authorizationErrorRedirect } from "./domain/authorization-response.js";
import { OidcError, SignInNotUsable } from "./domain/oidc-error.js";
import { SIGN_IN_LIFETIME_SECONDS } from "./domain/oidc-sign-in.js";
import {
    OidcAuthorizationRequestDto,
    OidcErrorResponseDto,
    OidcPushedAuthorizationRequestDto,
    OidcPushedAuthorizationResponseDto,
    OidcSignInCallbackQueryDto,
    OidcSignInStatusDto,
    OidcTokenRequestDto,
    OidcTokenResponseDto,
} from "./dto/oidc-protocol.dto.js";
import {
    clientCredentials,
    readCookie,
    signInCookieName,
} from "./oidc-http.util.js";
import {
    ID_TOKEN_SIGNER,
    type IdTokenSigner,
} from "./ports/id-token-signer.js";
import {
    OIDC_PROVIDER_SETTINGS,
    type OidcProviderSettings,
    oidcIssuer,
} from "./oidc-provider-settings.js";
import {
    type RenderedPage,
    renderMessagePage,
    renderSignInPage,
} from "./sign-in-page.js";

/**
 * The tenant's OpenID Provider: an application that speaks OpenID Connect
 * signs a user in with a presentation from their wallet and receives the
 * verified claims in an ID token.
 */
@ApiTags("OpenID Provider")
@Public()
@Controller("verifiers/:tenantId/oidc")
export class OidcProviderController {
    private readonly logger = new Logger(OidcProviderController.name);

    constructor(
        @Inject(OIDC_PROVIDER_SETTINGS)
        private readonly settings: OidcProviderSettings,
        private readonly discovery: BuildOidcDiscovery,
        private readonly authenticateClient: AuthenticateOidcClient,
        private readonly pushAuthorizationRequest: PushAuthorizationRequest,
        private readonly startSignIn: StartSignIn,
        private readonly finishSignIn: FinishSignIn,
        private readonly redeemCode: RedeemAuthorizationCode,
        @Inject(ID_TOKEN_SIGNER) private readonly signer: IdTokenSigner,
    ) {}

    @Get(".well-known/openid-configuration")
    @ApiOperation({ summary: "OpenID Provider metadata" })
    @ApiParam({ name: "tenantId", description: "Tenant identifier" })
    @ApiResponse({ status: 200, description: "Discovery document" })
    @ApiResponse({
        status: 404,
        description: "The tenant has no OpenID Connect client",
    })
    async metadata(
        @Param("tenantId") tenantId: string,
    ): Promise<Record<string, unknown>> {
        return notFoundIfDisabled(this.discovery.execute(tenantId));
    }

    @Get("jwks")
    @ApiOperation({ summary: "Keys that verify the ID tokens" })
    @ApiParam({ name: "tenantId", description: "Tenant identifier" })
    @ApiResponse({ status: 200, description: "JSON Web Key Set" })
    async jwks(
        @Param("tenantId") tenantId: string,
    ): Promise<{ keys: Record<string, unknown>[] }> {
        await notFoundIfDisabled(this.discovery.assertEnabled(tenantId));
        return { keys: await this.signer.publicKeys(tenantId) };
    }

    @Post("par")
    @HttpCode(HttpStatus.CREATED)
    @ApiConsumes("application/x-www-form-urlencoded")
    @ApiOperation({ summary: "Pushed authorization request (RFC 9126)" })
    @ApiParam({ name: "tenantId", description: "Tenant identifier" })
    @ApiBody({ type: OidcPushedAuthorizationRequestDto })
    @ApiResponse({ status: 201, type: OidcPushedAuthorizationResponseDto })
    @ApiResponse({ status: 400, type: OidcErrorResponseDto })
    @ApiResponse({ status: 401, type: OidcErrorResponseDto })
    async par(
        @Param("tenantId") tenantId: string,
        @Body() body: OidcPushedAuthorizationRequestDto,
        @Headers("authorization") authorization: string | undefined,
        @Res() res: Response,
    ): Promise<void> {
        await notFoundIfDisabled(this.discovery.assertEnabled(tenantId));
        try {
            const credentials = clientCredentials(authorization, body);
            const client = await this.authenticateClient.execute(
                tenantId,
                credentials,
            );
            const { client_secret: _secret, ...params } = body;
            const response = await this.pushAuthorizationRequest.execute(
                client,
                params,
            );
            res.status(HttpStatus.CREATED)
                .set("Cache-Control", "no-store")
                .json(response);
        } catch (error) {
            this.sendJsonError(res, error, authorization);
        }
    }

    @Get("authorize")
    @ApiOperation({
        summary: "Authorization endpoint",
        description:
            "A `secure` client sends client_id and request_uri from the pushed request; a `basic` client may send the parameters directly.",
    })
    @ApiParam({ name: "tenantId", description: "Tenant identifier" })
    @ApiResponse({ status: 303, description: "To the sign-in page" })
    @ApiResponse({ status: 400, description: "HTML page with the error" })
    authorize(
        @Param("tenantId") tenantId: string,
        @Query() query: OidcAuthorizationRequestDto,
        @Res() res: Response,
    ): Promise<void> {
        return this.handleAuthorize(tenantId, query, res);
    }

    @Post("authorize")
    @ApiConsumes("application/x-www-form-urlencoded")
    @ApiOperation({ summary: "Authorization endpoint (form post)" })
    @ApiParam({ name: "tenantId", description: "Tenant identifier" })
    @ApiBody({ type: OidcAuthorizationRequestDto })
    @ApiResponse({ status: 303, description: "To the sign-in page" })
    @ApiResponse({ status: 400, description: "HTML page with the error" })
    authorizePost(
        @Param("tenantId") tenantId: string,
        @Body() body: OidcAuthorizationRequestDto,
        @Res() res: Response,
    ): Promise<void> {
        return this.handleAuthorize(tenantId, body, res);
    }

    @Get("sign-in/:signInId")
    @ApiOperation({ summary: "Sign-in page with the wallet request" })
    @ApiParam({ name: "tenantId", description: "Tenant identifier" })
    @ApiParam({ name: "signInId", description: "Sign-in identifier" })
    @ApiResponse({ status: 200, description: "HTML sign-in page" })
    async signInPage(
        @Param("tenantId") tenantId: string,
        @Param("signInId") signInId: string,
        @Headers("cookie") cookie: string | undefined,
        @Res() res: Response,
    ): Promise<void> {
        try {
            const view = await this.finishSignIn.view(
                tenantId,
                signInId,
                readCookie(cookie, signInCookieName(signInId)),
            );
            const base = this.signInUrl(tenantId, signInId);
            if (view.state === "ready") {
                res.redirect(HttpStatus.SEE_OTHER, `${base}/complete`);
                return;
            }
            this.sendPage(
                res,
                HttpStatus.OK,
                await renderSignInPage({
                    sameDeviceRequest: view.sameDeviceRequest,
                    crossDeviceRequest: view.crossDeviceRequest,
                    statusUrl: `${base}/status`,
                    completeUrl: `${base}/complete`,
                }),
            );
        } catch (error) {
            this.sendBrowserError(res, error, tenantId);
        }
    }

    @Get("sign-in/:signInId/status")
    @ApiOperation({ summary: "Whether the sign-in page should continue" })
    @ApiParam({ name: "tenantId", description: "Tenant identifier" })
    @ApiParam({ name: "signInId", description: "Sign-in identifier" })
    @ApiResponse({ status: 200, type: OidcSignInStatusDto })
    @ApiResponse({
        status: 409,
        description: "The sign-in cannot continue in this browser",
    })
    async status(
        @Param("tenantId") tenantId: string,
        @Param("signInId") signInId: string,
        @Headers("cookie") cookie: string | undefined,
        @Res() res: Response,
    ): Promise<void> {
        try {
            const view = await this.finishSignIn.view(
                tenantId,
                signInId,
                readCookie(cookie, signInCookieName(signInId)),
            );
            res.set("Cache-Control", "no-store").json({ state: view.state });
        } catch (error) {
            if (error instanceof SignInNotUsable) {
                res.status(HttpStatus.CONFLICT)
                    .set("Cache-Control", "no-store")
                    .json({ error: "sign_in_not_usable" });
                return;
            }
            throw error;
        }
    }

    @Get("sign-in/:signInId/complete")
    @ApiOperation({
        summary: "Finish the sign-in in the browser that started it",
    })
    @ApiParam({ name: "tenantId", description: "Tenant identifier" })
    @ApiParam({ name: "signInId", description: "Sign-in identifier" })
    @ApiResponse({
        status: 303,
        description: "To the client with a code or an error",
    })
    async complete(
        @Param("tenantId") tenantId: string,
        @Param("signInId") signInId: string,
        @Headers("cookie") cookie: string | undefined,
        @Res() res: Response,
    ): Promise<void> {
        try {
            const step = await this.finishSignIn.fromBrowser(
                tenantId,
                signInId,
                readCookie(cookie, signInCookieName(signInId)),
            );
            this.sendStep(res, tenantId, signInId, step);
        } catch (error) {
            this.sendBrowserError(res, error, tenantId);
        }
    }

    @Get("sign-in/:signInId/callback")
    @ApiOperation({
        summary: "Where the wallet returns the holder after presenting",
    })
    @ApiParam({ name: "tenantId", description: "Tenant identifier" })
    @ApiParam({ name: "signInId", description: "Sign-in identifier" })
    @ApiResponse({
        status: 303,
        description: "To the client with a code or an error",
    })
    async callback(
        @Param("tenantId") tenantId: string,
        @Param("signInId") signInId: string,
        @Query() query: OidcSignInCallbackQueryDto,
        @Headers("cookie") cookie: string | undefined,
        @Res() res: Response,
    ): Promise<void> {
        try {
            const step = await this.finishSignIn.fromWallet(
                tenantId,
                signInId,
                readCookie(cookie, signInCookieName(signInId)),
                query.response_code,
            );
            this.sendStep(res, tenantId, signInId, step);
        } catch (error) {
            this.sendBrowserError(res, error, tenantId);
        }
    }

    @Post("token")
    @HttpCode(HttpStatus.OK)
    @ApiConsumes("application/x-www-form-urlencoded")
    @ApiOperation({ summary: "Token endpoint" })
    @ApiParam({ name: "tenantId", description: "Tenant identifier" })
    @ApiBody({ type: OidcTokenRequestDto })
    @ApiResponse({ status: 200, type: OidcTokenResponseDto })
    @ApiResponse({ status: 400, type: OidcErrorResponseDto })
    @ApiResponse({ status: 401, type: OidcErrorResponseDto })
    async token(
        @Param("tenantId") tenantId: string,
        @Body() body: OidcTokenRequestDto,
        @Headers("authorization") authorization: string | undefined,
        @Res() res: Response,
    ): Promise<void> {
        await notFoundIfDisabled(this.discovery.assertEnabled(tenantId));
        try {
            const client = await this.authenticateClient.execute(
                tenantId,
                clientCredentials(authorization, body),
            );
            const response = await this.redeemCode.execute(client, body);
            res.status(HttpStatus.OK)
                .set("Cache-Control", "no-store")
                .set("Pragma", "no-cache")
                .json(response);
        } catch (error) {
            this.sendJsonError(res, error, authorization);
        }
    }

    private async handleAuthorize(
        tenantId: string,
        params: OidcAuthorizationRequestDto,
        res: Response,
    ): Promise<void> {
        try {
            await this.discovery.assertEnabled(tenantId);
            const { signInId, browserSecret } = await this.startSignIn.execute(
                tenantId,
                params,
            );
            const base = this.signInUrl(tenantId, signInId);
            res.cookie(signInCookieName(signInId), browserSecret, {
                httpOnly: true,
                secure: this.settings.publicUrl.startsWith("https://"),
                // Lax: the wallet's redirect back is a top-level navigation.
                sameSite: "lax",
                path: new URL(base).pathname,
                maxAge: SIGN_IN_LIFETIME_SECONDS * 1000,
            });
            res.set("Cache-Control", "no-store").redirect(
                HttpStatus.SEE_OTHER,
                base,
            );
        } catch (error) {
            this.sendBrowserError(res, error, tenantId);
        }
    }

    private sendStep(
        res: Response,
        tenantId: string,
        signInId: string,
        step: SignInStep,
    ): void {
        switch (step.type) {
            case "redirect":
                res.clearCookie(signInCookieName(signInId), {
                    path: new URL(this.signInUrl(tenantId, signInId)).pathname,
                });
                res.set("Cache-Control", "no-store").redirect(
                    HttpStatus.SEE_OTHER,
                    step.url,
                );
                return;
            case "waiting":
                res.set("Cache-Control", "no-store").redirect(
                    HttpStatus.SEE_OTHER,
                    this.signInUrl(tenantId, signInId),
                );
                return;
            case "return-to-browser":
                this.sendPage(
                    res,
                    HttpStatus.OK,
                    renderMessagePage(
                        "Return to your browser",
                        "Your wallet shared the credential. Go back to the browser where you started signing in to continue.",
                    ),
                );
                return;
        }
    }

    /** Errors of the browser-facing endpoints: a redirect or a page. */
    private sendBrowserError(
        res: Response,
        error: unknown,
        tenantId: string,
    ): void {
        if (error instanceof OidcError && error.redirect) {
            res.set("Cache-Control", "no-store").redirect(
                HttpStatus.SEE_OTHER,
                authorizationErrorRedirect(
                    error.redirect.redirectUri,
                    error.code,
                    error.description,
                    oidcIssuer(this.settings.publicUrl, tenantId),
                    error.redirect.state,
                ),
            );
            return;
        }
        if (error instanceof OidcError || error instanceof SignInNotUsable) {
            this.sendPage(
                res,
                HttpStatus.BAD_REQUEST,
                renderMessagePage("Sign-in not possible", error.message),
            );
            return;
        }
        if (error instanceof OidcProviderNotEnabled) {
            this.sendPage(
                res,
                HttpStatus.NOT_FOUND,
                renderMessagePage("Sign-in not possible", error.message),
            );
            return;
        }
        this.logger.error(error, "Sign-in failed");
        this.sendPage(
            res,
            HttpStatus.INTERNAL_SERVER_ERROR,
            renderMessagePage(
                "Sign-in not possible",
                "Something went wrong. Return to the application and try again.",
            ),
        );
    }

    /** Errors of the client-facing JSON endpoints (RFC 6749 Section 5.2). */
    private sendJsonError(
        res: Response,
        error: unknown,
        authorization: string | undefined,
    ): void {
        if (!(error instanceof OidcError)) throw error;
        res.set("Cache-Control", "no-store");
        if (error.clientAuthenticationFailed) {
            if (authorization) {
                res.set("WWW-Authenticate", 'Basic realm="eudiplo"');
            }
            res.status(HttpStatus.UNAUTHORIZED);
        } else {
            res.status(HttpStatus.BAD_REQUEST);
        }
        res.json({ error: error.code, error_description: error.description });
    }

    private sendPage(res: Response, status: number, page: RenderedPage): void {
        res.status(status).set(page.headers).send(page.html);
    }

    private signInUrl(tenantId: string, signInId: string): string {
        return `${oidcIssuer(this.settings.publicUrl, tenantId)}/sign-in/${encodeURIComponent(signInId)}`;
    }
}

/** A tenant without clients offers no provider: 404. */
async function notFoundIfDisabled<T>(operation: Promise<T>): Promise<T> {
    try {
        return await operation;
    } catch (error) {
        if (error instanceof OidcProviderNotEnabled) {
            throw new NotFoundException(error.message);
        }
        throw error;
    }
}
