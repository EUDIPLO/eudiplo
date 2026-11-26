/**
 * Whose file or resource holds a secret reference: a tenant's, or the
 * operator's for the whole instance (the global `kms.json`).
 */
export type SecretScope =
    | { type: "tenant"; tenantId: string }
    | { type: "instance" };

/** Where a secret reference is used, which decides whether it may be. */
export interface SecretUse {
    scope: SecretScope;
    /**
     * The field that holds the reference, as `<Kind>:<path>` with array
     * indexes, for example `KmsConfig:providers.0.clientSecret`.
     */
    field: string;
    /** The URL the value is sent to, when it is sent somewhere. */
    destination?: string;
}
