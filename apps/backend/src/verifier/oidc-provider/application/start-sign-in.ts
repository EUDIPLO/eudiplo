import { v4 } from "uuid";
import type { OidcClient } from "../domain/oidc-client.js";
import { OidcError, SignInNotUsable } from "../domain/oidc-error.js";
import {
    type AuthorizationRequestParameters,
    isExpired,
    type OidcSignIn,
    OidcSignInStatus,
    SIGN_IN_LIFETIME_SECONDS,
    validateAuthorizationRequest,
} from "../domain/oidc-sign-in.js";
import {
    generateOpaqueSecret,
    hashOpaqueSecret,
} from "../domain/opaque-secret.js";
import { oidcIssuer } from "../oidc-provider-settings.js";
import type { OidcClientRepository } from "../ports/oidc-client.repository.js";
import type { OidcSignInRepository } from "../ports/oidc-sign-in.repository.js";
import type {
    SignInPresentation,
    StartedPresentation,
} from "../ports/sign-in-presentation.js";
import { REQUEST_URI_PREFIX } from "./push-authorization-request.js";

/** A sign-in the browser now holds, through a cookie with `browserSecret`. */
export interface StartedSignIn {
    signInId: string;
    /** Secret of the cookie that binds the sign-in to this browser. */
    browserSecret: string;
}

/**
 * Authorization endpoint: accept a pushed request (or, for a `basic` client,
 * the parameters themselves), bind the sign-in to the browser and request
 * the presentation from the wallet.
 */
export class StartSignIn {
    constructor(
        private readonly clients: Pick<OidcClientRepository, "findForTenant">,
        private readonly signIns: Pick<
            OidcSignInRepository,
            "insert" | "findForTenant" | "transition"
        >,
        private readonly presentations: Pick<
            SignInPresentation,
            "unusableReason" | "start"
        >,
        private readonly publicUrl: string,
        private readonly now: () => Date = () => new Date(),
    ) {}

    async execute(
        tenantId: string,
        params: AuthorizationRequestParameters,
    ): Promise<StartedSignIn> {
        const client = params.client_id
            ? await this.clients.findForTenant(tenantId, params.client_id)
            : null;
        if (!client) {
            throw new SignInNotUsable("The application is not registered.");
        }

        const browserSecret = generateOpaqueSecret();
        const binding = {
            browserBindingHash: hashOpaqueSecret(browserSecret),
            expiresAt: new Date(
                this.now().getTime() + SIGN_IN_LIFETIME_SECONDS * 1000,
            ),
        };
        const signIn =
            params.request_uri === undefined
                ? await this.fromParameters(client, params, binding)
                : await this.fromPushedRequest(
                      client,
                      params.request_uri,
                      binding,
                  );

        const issuer = oidcIssuer(this.publicUrl, tenantId);
        let presentation: StartedPresentation;
        try {
            presentation = await this.presentations.start(
                tenantId,
                signIn.presentationConfigId,
                `${issuer}/sign-in/${signIn.id}/callback`,
            );
        } catch (cause) {
            await this.signIns.transition(
                tenantId,
                signIn.id,
                OidcSignInStatus.Pending,
                { status: OidcSignInStatus.Failed },
            );
            throw new OidcError(
                "server_error",
                "The presentation could not be requested",
                {
                    redirect: {
                        redirectUri: signIn.redirectUri,
                        state: signIn.state,
                    },
                    cause,
                },
            );
        }
        await this.signIns.transition(
            tenantId,
            signIn.id,
            OidcSignInStatus.Pending,
            {
                presentationSessionId: presentation.sessionId,
                sameDeviceRequest: presentation.sameDeviceRequest,
                crossDeviceRequest: presentation.crossDeviceRequest,
            },
        );

        return { signInId: signIn.id, browserSecret };
    }

    /** A pushed request: only `client_id` and `request_uri` are read. */
    private async fromPushedRequest(
        client: OidcClient,
        requestUri: string,
        binding: { browserBindingHash: string; expiresAt: Date },
    ): Promise<OidcSignIn> {
        const invalid = () =>
            new SignInNotUsable(
                "The sign-in request is invalid or has expired. Return to the application and try again.",
            );
        if (!requestUri.startsWith(REQUEST_URI_PREFIX)) throw invalid();
        const id = requestUri.slice(REQUEST_URI_PREFIX.length);
        const signIn = await this.signIns.findForTenant(client.tenantId, id);
        if (
            !signIn ||
            signIn.clientId !== client.id ||
            signIn.status !== OidcSignInStatus.Pushed ||
            isExpired(signIn, this.now())
        ) {
            throw invalid();
        }
        // The request URI is single use: only one browser can claim it.
        const claimed = await this.signIns.transition(
            client.tenantId,
            id,
            OidcSignInStatus.Pushed,
            { status: OidcSignInStatus.Pending, ...binding },
        );
        if (!claimed) throw invalid();
        return { ...signIn, status: OidcSignInStatus.Pending, ...binding };
    }

    /** The parameters themselves, for a client with the `basic` profile. */
    private async fromParameters(
        client: OidcClient,
        params: AuthorizationRequestParameters,
        binding: { browserBindingHash: string; expiresAt: Date },
    ): Promise<OidcSignIn> {
        if (client.profile !== "basic") {
            throw new SignInNotUsable(
                "The application must push its authorization request first.",
            );
        }
        const request = validateAuthorizationRequest(client, params);
        const unusable = await this.presentations.unusableReason(
            client.tenantId,
            request.presentationConfigId,
        );
        if (unusable) {
            throw new OidcError("invalid_scope", unusable).redirectTo(
                request.redirectUri,
                request.state,
            );
        }
        const signIn: OidcSignIn = {
            id: v4(),
            tenantId: client.tenantId,
            clientId: client.id,
            redirectUri: request.redirectUri,
            state: request.state ?? null,
            nonce: request.nonce ?? null,
            scope: request.scope,
            presentationConfigId: request.presentationConfigId,
            codeChallenge: request.codeChallenge,
            requireSameDevice: request.requireSameDevice,
            status: OidcSignInStatus.Pending,
            walletReturnedElsewhere: false,
            ...binding,
        };
        await this.signIns.insert(signIn);
        return signIn;
    }
}
