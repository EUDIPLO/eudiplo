export const CREDENTIAL_CLAIMS_CONFIGURATION = Symbol(
    "CREDENTIAL_CLAIMS_CONFIGURATION",
);

export interface CredentialClaimsConfiguration {
    findForTenant(
        tenantId: string,
        credentialConfigurationId: string,
    ): Promise<{ attributeProviderId?: string | null } | null>;
}
