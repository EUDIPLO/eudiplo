/** Signs the ID tokens of a tenant's OpenID Provider and publishes its keys. */
export interface IdTokenSigner {
    sign(tenantId: string, claims: Record<string, unknown>): Promise<string>;
    /** Public keys that verify the tenant's ID tokens. */
    publicKeys(tenantId: string): Promise<Record<string, unknown>[]>;
}

export const ID_TOKEN_SIGNER = Symbol("ID_TOKEN_SIGNER");
