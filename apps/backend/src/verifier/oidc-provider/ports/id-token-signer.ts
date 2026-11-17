/** Signs the ID tokens of a tenant's OpenID Provider and publishes its keys. */
export interface IdTokenSigner {
    sign(tenantId: string, claims: Record<string, unknown>): Promise<string>;
    /** Public keys that verify the tenant's ID tokens. */
    publicKeys(tenantId: string): Promise<Record<string, unknown>[]>;
    /** JWS algorithms of those keys, as discovery advertises them. */
    algorithms(tenantId: string): Promise<string[]>;
}

export const ID_TOKEN_SIGNER = Symbol("ID_TOKEN_SIGNER");
