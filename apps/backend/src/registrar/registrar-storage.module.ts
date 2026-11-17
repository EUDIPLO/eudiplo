import { HttpModule } from "@nestjs/axios";
import { Module } from "@nestjs/common";
import { CryptoModule } from "../crypto/crypto.module.js";
import { IssuanceConfigModule } from "../issuer/configuration/issuance/issuance-config.module.js";
import { PresentationsModule } from "../verifier/presentations/presentations.module.js";
import { OutboundUrlPolicyModule } from "../webhook/outbound-url-policy.module.js";
import { AccessCertificateStorage } from "./access-certificate-storage.service.js";
import { IssuingCaService } from "./issuing-ca.service.js";
import { RegistrationCertificateStorage } from "./registration-certificate-storage.service.js";

/**
 * Registrar-neutral storage of the certificates registrar adapters obtain:
 * access certificates in access key chains, registration certificates in
 * presentation and issuance configurations, each with the same checks and
 * with revocation at the registrar when a certificate cannot be stored.
 * Every registrar adapter module imports it.
 */
@Module({
    imports: [
        CryptoModule,
        HttpModule,
        OutboundUrlPolicyModule,
        IssuanceConfigModule,
        PresentationsModule,
    ],
    providers: [
        IssuingCaService,
        AccessCertificateStorage,
        RegistrationCertificateStorage,
    ],
    exports: [AccessCertificateStorage, RegistrationCertificateStorage],
})
export class RegistrarStorageModule {}
