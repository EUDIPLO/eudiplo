/**
 * A certificate a registrar has just issued for EUDIPLO. Registrar adapters
 * hand it to the storage services, which keep it or, when that fails,
 * revoke it at the registrar, so that no unused certificate stays valid.
 *
 * @typeParam T - The certificate: a PEM for an access certificate, a JWT
 * for a registration certificate.
 */
export interface IssuedCertificate<T = string> {
    /** Display name of the registrar, such as "EUDI Hub", for messages and logs. */
    registrar: string;
    /** ID of the certificate at the registrar. */
    id: string;
    value: T;
    /**
     * Revoke the certificate at the registrar. Called at most once, when it
     * cannot be stored; failures are logged with a hint to revoke it by hand.
     * Absent when the certificate was not issued by this request, for example
     * one found again after a lost answer, which is then left as it is.
     */
    revoke?(): Promise<void>;
}
