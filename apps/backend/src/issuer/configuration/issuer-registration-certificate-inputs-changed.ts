/**
 * Published after a tenant's credential configurations or issuance
 * configuration were written, so a generated issuer registration certificate
 * can be renewed in the background (`renewal: "onCredentialConfigChange"`).
 * Listeners decide whether anything changed; publishing is cheap.
 */
export const ISSUER_REGISTRATION_CERTIFICATE_INPUTS_CHANGED =
    "issuer.registration-certificate-inputs.changed";

export interface IssuerRegistrationCertificateInputsChangedEvent {
    tenantId: string;
}
