import {
    authorizationCodeRedirect,
    authorizationErrorRedirect,
} from "../domain/authorization-response.js";
import { SignInNotUsable } from "../domain/oidc-error.js";
import {
    ACR_CROSS_DEVICE,
    ACR_SAME_DEVICE,
    AUTHORIZATION_CODE_LIFETIME_SECONDS,
    isExpired,
    type OidcSignIn,
    OidcSignInStatus,
    sameSecret,
} from "../domain/oidc-sign-in.js";
import {
    generateOpaqueSecret,
    hashOpaqueSecret,
    matchesOpaqueSecret,
} from "../domain/opaque-secret.js";
import { oidcIssuer } from "../oidc-provider-settings.js";
import type { OidcSignInRepository } from "../ports/oidc-sign-in.repository.js";
import type {
    SignInPresentation,
    SignInPresentationResult,
} from "../ports/sign-in-presentation.js";

/** What the browser is shown next. */
export type SignInStep =
    /** Return to the application. */
    | { type: "redirect"; url: string }
    /** Keep showing the sign-in page. */
    | { type: "waiting" }
    /** A browser without the binding: go back to the one that started it. */
    | { type: "return-to-browser" };

/** State of a sign-in for the polling sign-in page. */
export interface SignInView {
    sameDeviceRequest: string;
    crossDeviceRequest: string;
    /** `ready`: the page should continue to the completion endpoint. */
    state: "waiting" | "ready";
}

const NOT_YOURS =
    "This sign-in was started in another browser. Return to that browser to continue.";
const FINISHED =
    "This sign-in is already finished. Return to the application to start a new one.";

/**
 * Reads and completes a sign-in for the browser that started it. A
 * same-device sign-in completes when the wallet returns the holder with the
 * presentation's `response_code`; a cross-device one when the starting
 * browser asks after the wallet presented on another device. Only the
 * browser with the binding cookie can complete either.
 */
export class FinishSignIn {
    constructor(
        private readonly signIns: Pick<
            OidcSignInRepository,
            "findForTenant" | "transition"
        >,
        private readonly presentations: Pick<SignInPresentation, "result">,
        private readonly publicUrl: string,
        private readonly now: () => Date = () => new Date(),
    ) {}

    /** The sign-in page's view of a pending sign-in. */
    async view(
        tenantId: string,
        id: string,
        browserSecret: string | undefined,
    ): Promise<SignInView> {
        const signIn = await this.boundPendingSignIn(
            tenantId,
            id,
            browserSecret,
        );
        if (!signIn.sameDeviceRequest || !signIn.crossDeviceRequest) {
            throw new SignInNotUsable(FINISHED);
        }
        const ready =
            isExpired(signIn, this.now()) ||
            canFinishFromBrowser(signIn, await this.result(signIn));
        return {
            sameDeviceRequest: signIn.sameDeviceRequest,
            crossDeviceRequest: signIn.crossDeviceRequest,
            state: ready ? "ready" : "waiting",
        };
    }

    /** The starting browser asks to finish (cross-device or after a failure). */
    async fromBrowser(
        tenantId: string,
        id: string,
        browserSecret: string | undefined,
    ): Promise<SignInStep> {
        const signIn = await this.boundPendingSignIn(
            tenantId,
            id,
            browserSecret,
        );
        const result = await this.result(signIn);
        const ended = await this.endedStep(signIn, result);
        if (ended) return ended;
        if (result.status !== "completed") return { type: "waiting" };
        if (!result.crossDevice && !signIn.walletReturnedElsewhere) {
            // The wallet will return the holder here; wait for it.
            return { type: "waiting" };
        }
        return this.authorize(signIn, ACR_CROSS_DEVICE);
    }

    /** The wallet returned the holder to the callback (same device). */
    async fromWallet(
        tenantId: string,
        id: string,
        browserSecret: string | undefined,
        responseCode: string | undefined,
    ): Promise<SignInStep> {
        const signIn = await this.signIns.findForTenant(tenantId, id);
        if (!signIn) throw new SignInNotUsable(FINISHED);

        if (!matchesOpaqueSecret(signIn.browserBindingHash, browserSecret)) {
            // Another browser, for example the system browser a wallet
            // opens. It must not finish the sign-in; the starting browser
            // may, as a cross-device sign-in.
            if (signIn.status === OidcSignInStatus.Pending) {
                const result = await this.result(signIn);
                if (
                    result.status === "completed" &&
                    sameSecret(result.responseCode, responseCode)
                ) {
                    await this.signIns.transition(
                        tenantId,
                        id,
                        OidcSignInStatus.Pending,
                        { walletReturnedElsewhere: true },
                    );
                }
            }
            return { type: "return-to-browser" };
        }
        if (signIn.status !== OidcSignInStatus.Pending) {
            throw new SignInNotUsable(FINISHED);
        }

        const result = await this.result(signIn);
        const ended = await this.endedStep(signIn, result);
        if (ended) return ended;
        if (result.status !== "completed") return { type: "waiting" };
        if (!sameSecret(result.responseCode, responseCode)) {
            throw new SignInNotUsable(
                "The wallet's response does not belong to this sign-in.",
            );
        }
        return this.authorize(signIn, ACR_SAME_DEVICE);
    }

    private async boundPendingSignIn(
        tenantId: string,
        id: string,
        browserSecret: string | undefined,
    ): Promise<OidcSignIn> {
        const signIn = await this.signIns.findForTenant(tenantId, id);
        if (!signIn) throw new SignInNotUsable(FINISHED);
        if (!matchesOpaqueSecret(signIn.browserBindingHash, browserSecret)) {
            throw new SignInNotUsable(NOT_YOURS);
        }
        if (signIn.status !== OidcSignInStatus.Pending) {
            throw new SignInNotUsable(FINISHED);
        }
        return signIn;
    }

    /** The redirect for an expired sign-in or a failed presentation. */
    private async endedStep(
        signIn: OidcSignIn,
        result: SignInPresentationResult,
    ): Promise<SignInStep | null> {
        if (isExpired(signIn, this.now())) {
            return this.fail(signIn, "The sign-in expired");
        }
        if (result.status === "failed" || result.status === "expired") {
            return this.fail(
                signIn,
                result.failureReason ??
                    (result.status === "expired"
                        ? "The presentation expired"
                        : "The presentation failed"),
            );
        }
        return null;
    }

    private async authorize(
        signIn: OidcSignIn,
        acr: string,
    ): Promise<SignInStep> {
        if (signIn.requireSameDevice && acr !== ACR_SAME_DEVICE) {
            return this.fail(
                signIn,
                "The sign-in required a wallet on the same device",
            );
        }
        const now = this.now();
        const code = generateOpaqueSecret();
        const authorized = await this.signIns.transition(
            signIn.tenantId,
            signIn.id,
            OidcSignInStatus.Pending,
            {
                status: OidcSignInStatus.Authorized,
                codeHash: hashOpaqueSecret(code),
                codeExpiresAt: new Date(
                    now.getTime() + AUTHORIZATION_CODE_LIFETIME_SECONDS * 1000,
                ),
                acr,
                authTime: now,
                browserBindingHash: null,
            },
        );
        if (!authorized) throw new SignInNotUsable(FINISHED);
        return {
            type: "redirect",
            url: authorizationCodeRedirect(
                signIn.redirectUri,
                code,
                oidcIssuer(this.publicUrl, signIn.tenantId),
                signIn.state,
            ),
        };
    }

    private async fail(
        signIn: OidcSignIn,
        reason: string,
    ): Promise<SignInStep> {
        const failed = await this.signIns.transition(
            signIn.tenantId,
            signIn.id,
            OidcSignInStatus.Pending,
            { status: OidcSignInStatus.Failed, browserBindingHash: null },
        );
        if (!failed) throw new SignInNotUsable(FINISHED);
        return {
            type: "redirect",
            url: authorizationErrorRedirect(
                signIn.redirectUri,
                "access_denied",
                reason,
                oidcIssuer(this.publicUrl, signIn.tenantId),
                signIn.state,
            ),
        };
    }

    private result(signIn: OidcSignIn): Promise<SignInPresentationResult> {
        if (!signIn.presentationSessionId) {
            return Promise.resolve({ status: "open", crossDevice: false });
        }
        return this.presentations.result(
            signIn.tenantId,
            signIn.presentationSessionId,
        );
    }
}

/** Whether the starting browser can finish now, with a code or an error. */
function canFinishFromBrowser(
    signIn: OidcSignIn,
    result: SignInPresentationResult,
): boolean {
    if (result.status === "failed" || result.status === "expired") return true;
    return (
        result.status === "completed" &&
        (result.crossDevice || signIn.walletReturnedElsewhere)
    );
}
