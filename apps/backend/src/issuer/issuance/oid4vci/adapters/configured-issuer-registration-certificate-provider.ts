import { Logger } from "@nestjs/common";
import {
    type IssuerRegistrationCertificateSettings,
    isJwtActive,
} from "../domain/issuer-registration-certificate.js";
import type { IssuerRegistrationCertificateProvider } from "../ports/issuer-registration-certificate-provider.js";

/**
 * Provides the issuer registration certificate stored in the issuance
 * configuration (`registrationCertificate.jwt`), as long as it is valid. The
 * certificate comes from a registrar, for example the EUDI Hub; EUDIPLO does
 * not renew it.
 */
export class ConfiguredIssuerRegistrationCertificateProvider
    implements IssuerRegistrationCertificateProvider
{
    private readonly logger = new Logger(
        ConfiguredIssuerRegistrationCertificateProvider.name,
    );

    resolve(
        tenantId: string,
        settings: IssuerRegistrationCertificateSettings,
    ): Promise<string | undefined> {
        if (!settings.jwt) {
            this.logger.warn(
                `[${tenantId}] registrationCertificate is enabled but no jwt is configured`,
            );
            return Promise.resolve(undefined);
        }
        if (!isJwtActive(settings.jwt)) {
            this.logger.warn(
                `[${tenantId}] The configured issuer registration certificate is expired or not yet valid; request a new one`,
            );
            return Promise.resolve(undefined);
        }
        return Promise.resolve(settings.jwt);
    }
}
