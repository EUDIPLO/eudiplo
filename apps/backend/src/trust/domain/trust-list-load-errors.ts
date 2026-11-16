/** A response with a status other than 2xx. */
export class TrustFetchStatusError extends Error {
    constructor(readonly status: number) {
        super(`Request failed with status code ${status}`);
        this.name = "TrustFetchStatusError";
    }
}

/** A trust list could not be fetched; `cause` holds the fetch error. */
export class TrustListFetchError extends Error {
    constructor(message: string, options: { cause: unknown }) {
        super(message, options);
        this.name = "TrustListFetchError";
    }
}

/**
 * A trust list's signature could not be verified: it does not verify with
 * the key of its reference, or the reference has no key.
 */
export class TrustListVerificationError extends Error {
    constructor(
        message: string,
        /** Why, without the list URL. */
        readonly detail: string,
    ) {
        super(message);
        this.name = "TrustListVerificationError";
    }
}
