/**
 * The status check of an attestation rejected it: it is revoked or
 * suspended, or its status could not be checked and the status check mode
 * does not tolerate that. The message can be returned to the wallet; it
 * names no status list URL or network error, which stay in the cause.
 */
export class AttestationStatusRejected extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = "AttestationStatusRejected";
    }
}
