import type { StatusListEntry } from "@owf/token-status-list";

/**
 * A `status` claim or `status_list` reference that draft-ietf-oauth-status-list
 * does not allow. It names no status the verifier could check, so it is
 * rejected whether the status check is strict or best effort.
 */
export class MalformedStatusReferenceError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "MalformedStatusReferenceError";
    }
}

/** RFC 3986 Section 3.1 scheme, then only characters a URI may contain. */
const ABSOLUTE_URI = /^[A-Za-z][A-Za-z0-9+.-]*:[\w.~:/?#[\]@!$&'()*+,;=%-]*$/;

/**
 * Whether `value` is a URI as RFC 3986 Section 3 defines it, not a relative
 * reference: it starts with a scheme, contains no whitespace or characters
 * outside the URI character set, and parses as a URL. A fragment is allowed.
 */
export function isAbsoluteUri(value: string): boolean {
    return ABSOLUTE_URI.test(value) && URL.canParse(value);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The `status_list` reference (uri and idx) of a `status` claim
 * (draft-ietf-oauth-status-list Section 6).
 *
 * The claim is an object with at least one status mechanism (Section 6.2);
 * one without `status_list` uses another mechanism and counts as no
 * reference. A `status_list` reference is an object with a `uri` that is a
 * URI and an `idx` that is a non-negative integer (Section 6.2).
 *
 * @param status The `status` claim, `undefined` when the token has none
 * @returns The reference, or `undefined` if the claim has no `status_list`
 * @throws MalformedStatusReferenceError if the claim or reference is malformed
 */
export function parseStatusListReference(
    status: unknown,
): StatusListEntry | undefined {
    if (status === undefined) {
        return undefined;
    }
    if (!isJsonObject(status) || Object.keys(status).length === 0) {
        throw new MalformedStatusReferenceError(
            "The status claim is not a JSON object with a status mechanism",
        );
    }
    const entry = status.status_list;
    if (entry === undefined) {
        return undefined;
    }
    if (!isJsonObject(entry)) {
        throw new MalformedStatusReferenceError(
            "The status_list claim is not a JSON object",
        );
    }
    if (typeof entry.uri !== "string" || !isAbsoluteUri(entry.uri)) {
        throw new MalformedStatusReferenceError(
            "The status_list claim has no uri that is an absolute URI",
        );
    }
    if (
        typeof entry.idx !== "number" ||
        !Number.isSafeInteger(entry.idx) ||
        entry.idx < 0
    ) {
        throw new MalformedStatusReferenceError(
            "The status_list claim has no non-negative integer idx",
        );
    }
    return { uri: entry.uri, idx: entry.idx };
}
