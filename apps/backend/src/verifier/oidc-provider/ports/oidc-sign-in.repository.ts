import type { OidcSignIn, OidcSignInStatus } from "../domain/oidc-sign-in.js";

export type OidcSignInChanges = Partial<
    Omit<OidcSignIn, "id" | "tenantId" | "clientId" | "createdAt">
>;

/**
 * Persistence of sign-ins. Status changes are conditional writes: the result
 * says whether this caller moved the sign-in, so a code, a pushed request or
 * a completion is only ever used once.
 */
export interface OidcSignInRepository {
    insert(signIn: OidcSignIn): Promise<void>;
    findForTenant(tenantId: string, id: string): Promise<OidcSignIn | null>;
    /** The authorized sign-in holding this code hash. */
    findAuthorizedByCode(
        tenantId: string,
        codeHash: string,
    ): Promise<OidcSignIn | null>;
    /**
     * Apply `changes` only while the sign-in has status `from`; true when
     * this call changed it.
     */
    transition(
        tenantId: string,
        id: string,
        from: OidcSignInStatus,
        changes: OidcSignInChanges,
    ): Promise<boolean>;
    /** Delete sign-ins that expired before `now`; returns the number deleted. */
    deleteExpired(now: Date): Promise<number>;
}

export const OIDC_SIGN_IN_REPOSITORY = Symbol("OIDC_SIGN_IN_REPOSITORY");
