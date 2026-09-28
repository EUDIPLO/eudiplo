/**
 * Structured, format-agnostic result of a presentation verification, persisted
 * on the session and surfaced to callers. Covers both success and failure,
 * positive provenance and diagnostics, at per-credential granularity.
 *
 * Machine-readable `error` / `code` fields are stable; consumers branch on them.
 * `message` fields are short and safe for display. Verbose diagnostics
 * (certificate subjects, full chains, configured-list URLs) never appear here —
 * they stay in the session-log/audit channel.
 */

/** Trust provenance for a successfully verified credential. */
export interface VerificationProvenance {
    /** Matched trusted entity id, or the issuance certificate subject. */
    matchedIssuer?: string;
    /** Thumbprint of the matched issuance certificate. */
    issuanceThumbprint?: string;
    /** How the chain matched a trusted entity (`ca` / `leaf-pinned` / …). */
    matchMode?: string;
    /** Thumbprint of the entity's revocation certificate, if any. */
    revocationThumbprint?: string;
}

/** A non-fatal condition observed during verification. */
interface SessionOutcomeWarning {
    code: string;
    message: string;
}

/** Per-credential verification outcome. */
interface SessionOutcomeCredential {
    /** Requested credential id (DCQL), when known. */
    id?: string;
    /** Credential format, e.g. `mso_mdoc` or `dc+sd-jwt`. */
    format?: string;
    /** mDOC docType or SD-JWT-VC vct, when known. */
    docType?: string;
    verified: boolean;
    /** Machine-readable failure code (on failure). */
    error?: string;
    /** Short, safe message (on failure). */
    message?: string;
    /** Trust provenance (on success). */
    trust?: VerificationProvenance;
    warnings?: SessionOutcomeWarning[];
}

/** Overall verification outcome for a session. */
export interface SessionOutcome {
    result: "success" | "failed";
    /** Top-level failure code (on failure). */
    error?: string;
    /** Top-level short, safe message (on failure). */
    message?: string;
    credentials?: SessionOutcomeCredential[];
}
