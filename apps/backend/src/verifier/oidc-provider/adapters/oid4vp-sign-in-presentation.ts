import { SessionNotFound } from "../../../session/application/session-errors.js";
import type { SessionStore } from "../../../session/application/session-store.js";
import type { VerificationProvenance } from "../../../session/domain/session-outcome.js";
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
            "getPresentationConfigs"
        >,
        private readonly sessions: Pick<SessionStore, "getForTenant">,
        private readonly publicUrl: string,
        private readonly now: () => Date = () => new Date(),
    ) {}

    async unusableReason(
        tenantId: string,
        presentationConfigId: string,
        subjectCredentialId?: string,
    ): Promise<string | undefined> {
        // The list, not getPresentationConfig: that one turns every failure
        // into a 409, so a database error would read as a missing config.
        const config = (
            await this.configs.getPresentationConfigs(tenantId)
        ).find((entry) => entry.id === presentationConfigId);
        if (!config) {
            return `Presentation config '${presentationConfigId}' does not exist`;
        }
        if ((config.transaction_data?.length ?? 0) > 0) {
            // An authorization request cannot supply transaction data.
            return `Presentation config '${presentationConfigId}' defines transaction data and cannot verify a sign-in`;
        }
        if (subjectCredentialId !== undefined) {
            const query = config.dcql_query?.credentials?.find(
                (credential) => credential.id === subjectCredentialId,
            );
            if (!query) {
                return `Presentation config '${presentationConfigId}' has no credential query '${subjectCredentialId}' for the subject`;
            }
            // The same rule the verification applies: at least one
            // authority that names something.
            const trusted = (query.trusted_authorities ?? []).some(
                (authority) => (authority.values?.length ?? 0) > 0,
            );
            if (!trusted) {
                return `Credential query '${subjectCredentialId}' of presentation config '${presentationConfigId}' must name trusted_authorities to identify users by one of its claims`;
            }
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
            .catch((error) => {
                // Deleted, for example by the session retention.
                if (error instanceof SessionNotFound) return null;
                throw error;
            });
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
                    issuers: Object.fromEntries(
                        (session.outcome?.credentials ?? []).flatMap(
                            (credential) => {
                                const issuer = issuerIdentity(credential.trust);
                                return credential.id && issuer
                                    ? [[credential.id, issuer]]
                                    : [];
                            },
                        ),
                    ),
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

/**
 * A unique identity of the issuer a credential was trusted as: the entity
 * ID under OpenID Federation, else the thumbprint of the matched trust list
 * certificate. The trust list entry's name is not unique, so it is not used.
 */
function issuerIdentity(
    trust: VerificationProvenance | undefined,
): string | undefined {
    if (!trust) return undefined;
    if (trust.matchMode === "federation" && trust.matchedIssuer) {
        return `federation:${trust.matchedIssuer}`;
    }
    return trust.issuanceThumbprint
        ? `x509:${trust.issuanceThumbprint}`
        : undefined;
}
