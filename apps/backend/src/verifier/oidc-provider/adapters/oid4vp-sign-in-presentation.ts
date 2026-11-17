import type { SessionStore } from "../../../session/application/session-store.js";
import { SessionStatus } from "../../../session/domain/session-state.js";
import type { Oid4vpService } from "../../oid4vp/oid4vp.service.js";
import type { PresentationConfigService } from "../../presentations/configuration/presentation-config.service.js";
import type {
    SignInPresentation,
    SignInPresentationResult,
    StartedPresentation,
} from "../ports/sign-in-presentation.js";

/** Starts sign-in presentations with EUDIPLO's OID4VP verifier. */
export class Oid4vpSignInPresentation implements SignInPresentation {
    constructor(
        private readonly oid4vp: Pick<Oid4vpService, "createRequest">,
        private readonly configs: Pick<
            PresentationConfigService,
            "getPresentationConfig"
        >,
        private readonly sessions: Pick<SessionStore, "getForTenant">,
        private readonly publicUrl: string,
        private readonly now: () => Date = () => new Date(),
    ) {}

    async unusableReason(
        tenantId: string,
        presentationConfigId: string,
    ): Promise<string | undefined> {
        const config = await this.configs
            .getPresentationConfig(presentationConfigId, tenantId)
            .catch(() => null);
        if (!config) {
            return `Presentation config '${presentationConfigId}' does not exist`;
        }
        if ((config.transaction_data?.length ?? 0) > 0) {
            // An authorization request cannot supply transaction data.
            return `Presentation config '${presentationConfigId}' defines transaction data and cannot verify a sign-in`;
        }
        return undefined;
    }

    async start(
        tenantId: string,
        presentationConfigId: string,
        callbackUrl: string,
    ): Promise<StartedPresentation> {
        const offer = await this.oid4vp.createRequest(
            presentationConfigId,
            { redirectUri: callbackUrl },
            tenantId,
            false,
            this.publicUrl,
        );
        return {
            sessionId: offer.session,
            sameDeviceRequest: `openid4vp://?${offer.uri}`,
            crossDeviceRequest: `openid4vp://?${offer.crossDeviceUri}`,
        };
    }

    async result(
        tenantId: string,
        sessionId: string,
    ): Promise<SignInPresentationResult> {
        const session = await this.sessions
            .getForTenant(tenantId, sessionId)
            .catch(() => null);
        if (!session) {
            return {
                status: "expired",
                crossDevice: false,
                failureReason: "The presentation no longer exists",
            };
        }
        // Fetching the request meant for another device clears the
        // redirect, so the wallet does not send the holder anywhere.
        const crossDevice = session.redirectUri === null;
        switch (session.status) {
            case SessionStatus.Completed:
                return {
                    status: "completed",
                    crossDevice,
                    responseCode: session.responseCode,
                    credentials: session.credentials ?? [],
                };
            case SessionStatus.Failed:
            case SessionStatus.Cancelled:
                return {
                    status: "failed",
                    crossDevice,
                    failureReason:
                        session.outcome?.message ??
                        session.outcome?.error ??
                        undefined,
                };
            case SessionStatus.Expired:
                return { status: "expired", crossDevice };
            default:
                // The status changes to expired only on the tidy-up run.
                if (
                    session.expiresAt &&
                    session.expiresAt.getTime() <= this.now().getTime()
                ) {
                    return { status: "expired", crossDevice };
                }
                return { status: "open", crossDevice };
        }
    }
}
