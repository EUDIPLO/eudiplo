import { Role } from "../../auth/roles/role.enum.js";
import type { SessionType } from "./session-list.js";

/** What the session rules need of a management caller: its roles. */
export interface SessionCaller {
    roles?: readonly Role[];
}

const issuanceRoles = [Role.IssuanceOffer, Role.Issuances];
const presentationRoles = [Role.PresentationRequest, Role.Presentations];

/**
 * The session type a client may delete and cancel: issuance sessions need
 * `issuance:offer` or `issuance:manage`, presentation sessions
 * `presentation:request` or `presentation:manage`. `undefined` means both.
 */
export function sessionChangeScope(
    token: SessionCaller,
): SessionType | undefined {
    return scopeOf(token, issuanceRoles, presentationRoles);
}

/** The roles of the endpoints that cancel and delete sessions. */
const changerRoles = [Role.IssuanceOffer, Role.PresentationRequest];

/**
 * Whether the client may cancel and delete sessions of `type`: one of the
 * roles of those endpoints and a role of that side, as for
 * {@link sessionChangeScope}. Only then does it receive the sessions of that
 * type that are open for a wallet and the values a wallet redeems or answers
 * them with; `sessions:read`, also together with a manage role, only reads.
 */
export function mayChangeSessions(
    token: SessionCaller,
    type: SessionType,
): boolean {
    const roles = token.roles ?? [];
    const sideRoles = type === "issuance" ? issuanceRoles : presentationRoles;
    return (
        changerRoles.some((role) => roles.includes(role)) &&
        sideRoles.some((role) => roles.includes(role))
    );
}

/**
 * The session types a client reads through `sessions:read` but may not
 * change (see {@link mayChangeSessions}): their sessions that are still open
 * for a wallet are hidden from it, since the session ID of an ISO 18013-7
 * request or of an offer created before 10.0 lets a wallet answer or redeem
 * it, and the others come without those values. Empty without
 * `sessions:read`, so other role sets read as before.
 */
export function readOnlySessionTypes(token: SessionCaller): SessionType[] {
    if (!token.roles?.includes(Role.SessionsRead)) return [];
    return (["issuance", "presentation"] as const).filter(
        (type) => !mayChangeSessions(token, type),
    );
}

/**
 * The session type a client may read and follow: as for
 * {@link sessionChangeScope}, and both types with `sessions:read`. So a
 * verifier-only client never sees issued credential payloads and an
 * issuer-only client never sees presented credentials, unless it holds
 * `sessions:read`. Never use it for changes, or `sessions:read` would widen
 * them to the other type.
 */
export function sessionReadScope(
    token: SessionCaller,
): SessionType | undefined {
    return scopeOf(
        token,
        [...issuanceRoles, Role.SessionsRead],
        [...presentationRoles, Role.SessionsRead],
    );
}

/**
 * The session type whose credential status a client may read: as for
 * {@link sessionReadScope}, and issuance sessions with `credentials:status`,
 * which changes their status.
 */
export function credentialStatusScope(
    token: SessionCaller,
): SessionType | undefined {
    return scopeOf(
        token,
        [...issuanceRoles, Role.SessionsRead, Role.CredentialStatus],
        [...presentationRoles, Role.SessionsRead],
    );
}

function scopeOf(
    token: SessionCaller,
    issuanceSide: Role[],
    presentationSide: Role[],
): SessionType | undefined {
    const roles = token.roles ?? [];
    const issuance = issuanceSide.some((role) => roles.includes(role));
    const presentation = presentationSide.some((role) => roles.includes(role));
    if (issuance && presentation) return undefined;
    if (issuance) return "issuance";
    if (presentation) return "presentation";
    // Unreachable behind the controllers' role guards. Fail closed: a missing
    // guard is a server bug, never a reason to show every session.
    throw new Error("Token has no role that grants access to sessions");
}
