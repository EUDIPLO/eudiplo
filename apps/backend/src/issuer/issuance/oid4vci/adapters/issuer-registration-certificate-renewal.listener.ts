import {
    Inject,
    Injectable,
    Logger,
    type OnModuleDestroy,
} from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { IssuanceConfigurationNotFound } from "../../../configuration/issuance/domain/issuance-configuration.js";
import { IssuanceService } from "../../../configuration/issuance/issuance.service.js";
import {
    ISSUER_REGISTRATION_CERTIFICATE_INPUTS_CHANGED,
    type IssuerRegistrationCertificateInputsChangedEvent,
} from "../../../configuration/issuer-registration-certificate-inputs-changed.js";
import { renewsOnConfigChange } from "../domain/issuer-registration-certificate.js";
import {
    ISSUER_REGISTRATION_CERTIFICATE_PROVIDER,
    type IssuerRegistrationCertificateProvider,
} from "../ports/issuer-registration-certificate-provider.js";

/** Changes within this window lead to one renewal, e.g. during an import. */
export const RENEWAL_DEBOUNCE_MS = 2000;

/**
 * Renews a generated issuer registration certificate in the background after
 * the tenant's credential or issuance configuration changed, when its
 * `renewal` is `onCredentialConfigChange`. The provider requests a new
 * certificate only when the fingerprint changed, and logs failures; metadata
 * requests stay the fallback.
 */
@Injectable()
export class IssuerRegistrationCertificateRenewalListener
    implements OnModuleDestroy
{
    private readonly logger = new Logger(
        IssuerRegistrationCertificateRenewalListener.name,
    );
    private readonly pending = new Map<string, NodeJS.Timeout>();

    constructor(
        @Inject(ISSUER_REGISTRATION_CERTIFICATE_PROVIDER)
        private readonly certificates: IssuerRegistrationCertificateProvider,
        private readonly issuance: IssuanceService,
    ) {}

    @OnEvent(ISSUER_REGISTRATION_CERTIFICATE_INPUTS_CHANGED)
    onInputsChanged({
        tenantId,
    }: IssuerRegistrationCertificateInputsChangedEvent): void {
        clearTimeout(this.pending.get(tenantId));
        const timer = setTimeout(() => {
            this.pending.delete(tenantId);
            this.renew(tenantId).catch((error: unknown) =>
                this.logger.warn(
                    `[${tenantId}] Background renewal of the issuer registration certificate failed: ${error instanceof Error ? error.message : "unknown error"}`,
                ),
            );
        }, RENEWAL_DEBOUNCE_MS);
        timer.unref();
        this.pending.set(tenantId, timer);
    }

    async renew(tenantId: string): Promise<void> {
        const settings = await this.issuance
            .getIssuanceConfiguration(tenantId)
            .then((config) => config.registrationCertificate)
            .catch((error: unknown) => {
                // A tenant without issuer settings has nothing to renew.
                if (error instanceof IssuanceConfigurationNotFound) {
                    return undefined;
                }
                throw error;
            });
        if (!settings || !renewsOnConfigChange(settings)) {
            return;
        }
        await this.certificates.resolve(tenantId, settings);
    }

    onModuleDestroy(): void {
        for (const timer of this.pending.values()) {
            clearTimeout(timer);
        }
        this.pending.clear();
    }
}
