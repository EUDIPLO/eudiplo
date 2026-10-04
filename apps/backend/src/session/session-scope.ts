import { Role } from "../auth/roles/role.enum.js";
import type { TokenPayload } from "../auth/token.decorator.js";
import type { SessionType } from "./domain/session-list.js";

/**
 * The session type a client may read, delete and follow: issuance sessions need
 * `issuance:offer` or `issuance:manage`, presentation sessions
 * `presentation:request` or `presentation:manage`. `undefined` means both.
 * A verifier-only client never sees issued credential payloads, an
 * issuer-only client never sees presented credentials.
 */
export function sessionScope(token: TokenPayload): SessionType | undefined {
    const roles = token.roles ?? [];
    const issuance =
        roles.includes(Role.IssuanceOffer) || roles.includes(Role.Issuances);
    const presentation =
        roles.includes(Role.PresentationRequest) ||
        roles.includes(Role.Presentations);
    if (issuance && presentation) return undefined;
    if (issuance) return "issuance";
    if (presentation) return "presentation";
    // Unreachable behind the controllers' role guards. Fail closed: a missing
    // guard is a server bug, never a reason to show every session.
    throw new Error("Token has no role that grants access to sessions");
}
