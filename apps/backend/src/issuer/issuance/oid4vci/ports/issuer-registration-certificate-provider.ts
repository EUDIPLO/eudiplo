import type { IssuerRegistrationCertificateSettings } from "../domain/issuer-registration-certificate.js";

/**
 * Provides the issuer registration certificate advertised in `issuer_info`.
 * Returns `undefined` when no active certificate is available; problems are
 * logged by the implementation and never fail metadata generation.
 */
export interface IssuerRegistrationCertificateProvider {
    resolve(
        tenantId: string,
        settings: IssuerRegistrationCertificateSettings,
    ): Promise<string | undefined>;
}

export const ISSUER_REGISTRATION_CERTIFICATE_PROVIDER = Symbol(
    "ISSUER_REGISTRATION_CERTIFICATE_PROVIDER",
);
