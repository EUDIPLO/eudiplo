export const ISSUED_CREDENTIAL_REVOCATION = Symbol(
    "ISSUED_CREDENTIAL_REVOCATION",
);

/** Revokes the credentials a tenant issued under a credential configuration. */
export interface IssuedCredentialRevocation {
    /**
     * Revoke the status entries of every credential the tenant issued under
     * the configuration. Credentials without a status entry cannot be revoked
     * and are not counted. Entries that are already revoked stay revoked and
     * are not counted either.
     * @returns The number of credentials this call revoked
     */
    revokeIssuedUnder(
        tenantId: string,
        credentialConfigurationId: string,
    ): Promise<number>;
}
