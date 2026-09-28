export const CREDENTIAL_NONCE_REPOSITORY = Symbol(
    "CREDENTIAL_NONCE_REPOSITORY",
);

export interface CredentialNonce {
    tenantId: string;
    nonce: string;
    expiresAt: Date;
}

export interface CredentialNonceRepository {
    save(nonce: CredentialNonce): Promise<void>;
    find(tenantId: string, nonce: string): Promise<CredentialNonce | null>;
    delete(tenantId: string, nonce: string): Promise<boolean>;
    deleteExpired(before: Date): Promise<void>;
}
