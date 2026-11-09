import { Logger } from "@nestjs/common";
import type { SessionStore } from "../../../session/application/session-store.js";
import type { SessionData } from "../../../session/domain/session-data.js";
import type { TrustListRef } from "../../../trust/types.js";
import type { WalletAttestationService } from "../../../trust/wallet-attestation.service.js";
import type { WebhookConfig } from "../../../webhook/webhook.dto.js";
import type { WebhookService } from "../../../webhook/webhook.service.js";
import type { CredentialConfigurationRepository } from "../../configuration/credentials/ports/credential-configuration.repository.js";
import type { IssuanceService } from "../../configuration/issuance/issuance.service.js";
import type { WebhookEndpointRepository } from "../../configuration/webhook-endpoint/ports/webhook-endpoint.repository.js";
import { resolveWalletAttestationPolicy } from "../../issuance/oid4vci/authorization/domain/wallet-attestation-policy.js";
import type { StatusListService } from "../../status-list/status-list.service.js";
import type {
    CredentialStatusEntry,
    CredentialsRevokedWithWalletUnit,
    IssuedCredentialStatus,
    WalletUnitRevocationNotifier,
    WalletUnitRevocationSettingsSource,
    WalletUnitStatusReader,
} from "../ports/wallet-unit-revocation.ports.js";

/** Reads wallet unit status with the checks of the issuance-time check. */
export class TrustWalletUnitStatusReader implements WalletUnitStatusReader {
    constructor(
        private readonly walletAttestations: Pick<
            WalletAttestationService,
            "readWalletUnitStatuses"
        >,
    ) {}

    read(
        tenantId: string,
        uri: string,
        certificates: string[],
        indexes: number[],
        trustLists: TrustListRef[],
    ): Promise<Map<number, number>> {
        return this.walletAttestations.readWalletUnitStatuses(
            tenantId,
            certificates,
            uri,
            indexes,
            trustLists,
        );
    }
}

export class StatusListIssuedCredentialStatus
    implements IssuedCredentialStatus
{
    constructor(
        private readonly statusLists: Pick<
            StatusListService,
            "currentValues" | "revokeEntries" | "buildStatusListUri"
        >,
    ) {}

    currentValues(tenantId: string, entries: readonly CredentialStatusEntry[]) {
        return this.statusLists.currentValues(tenantId, entries);
    }

    revoke(tenantId: string, entries: readonly CredentialStatusEntry[]) {
        return this.statusLists.revokeEntries(tenantId, entries);
    }

    uri(tenantId: string, statusListId: string): string {
        return this.statusLists.buildStatusListUri(tenantId, statusListId);
    }
}

export class ConfigurationWalletUnitRevocationSettings
    implements WalletUnitRevocationSettingsSource
{
    constructor(
        private readonly issuance: Pick<
            IssuanceService,
            "getIssuanceConfiguration"
        >,
        private readonly credentialConfigurations: Pick<
            CredentialConfigurationRepository,
            "findForTenant"
        >,
    ) {}

    async walletProviderTrustLists(tenantId: string): Promise<TrustListRef[]> {
        const config = await this.issuance.getIssuanceConfiguration(tenantId);
        // The lists the credential endpoint checks key attestations against.
        return resolveWalletAttestationPolicy(config).walletProviderTrustLists;
    }

    async revokesWithWalletUnit(
        tenantId: string,
        credentialConfigurationId: string,
    ): Promise<boolean> {
        const config = await this.credentialConfigurations.findForTenant(
            tenantId,
            credentialConfigurationId,
        );
        return (
            config?.revokeWithWalletUnit === true &&
            config.statusManagement === true
        );
    }
}

/**
 * Sends the revocation to the webhook endpoint of the credential
 * configuration, else to the webhook endpoint of the offer while the
 * issuance session exists. An endpoint that no longer exists is skipped.
 */
export class WebhookWalletUnitRevocationNotifier
    implements WalletUnitRevocationNotifier
{
    private readonly logger = new Logger(
        WebhookWalletUnitRevocationNotifier.name,
    );

    constructor(
        private readonly webhooks: Pick<
            WebhookService,
            "sendCredentialsRevokedWebhook"
        >,
        private readonly endpoints: Pick<
            WebhookEndpointRepository,
            "findForTenant"
        >,
        private readonly credentialConfigurations: Pick<
            CredentialConfigurationRepository,
            "findForTenant"
        >,
        private readonly sessions: Pick<SessionStore, "getForTenant">,
    ) {}

    async credentialsRevoked(
        event: CredentialsRevokedWithWalletUnit,
    ): Promise<void> {
        try {
            const session = await this.sessions
                .getForTenant(event.tenantId, event.sessionId)
                .catch(() => undefined);
            const webhook = await this.resolveWebhook(event, session);
            if (!webhook) return;
            await this.webhooks.sendCredentialsRevokedWebhook(webhook, {
                session: event.sessionId,
                ...(session?.reference && { reference: session.reference }),
                credentialConfigurationId: event.credentialConfigurationId,
                statusEntries: event.statusEntries,
            });
        } catch (error) {
            this.logger.warn(
                `Could not report credentials of session ${event.sessionId} revoked with their wallet unit to the webhook: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    private async resolveWebhook(
        event: CredentialsRevokedWithWalletUnit,
        session: SessionData | undefined,
    ): Promise<WebhookConfig | undefined> {
        const configuration = await this.credentialConfigurations.findForTenant(
            event.tenantId,
            event.credentialConfigurationId,
        );
        for (const endpointId of [
            configuration?.webhookEndpointId,
            session?.webhookEndpointId,
        ]) {
            if (!endpointId) continue;
            const endpoint = await this.endpoints.findForTenant(
                event.tenantId,
                endpointId,
            );
            if (endpoint) return { url: endpoint.url, auth: endpoint.auth };
            this.logger.warn(
                `Webhook endpoint ${endpointId} of tenant ${event.tenantId} does not exist; the credentials of session ${event.sessionId} revoked with their wallet unit are reported elsewhere or not at all`,
            );
        }
        return undefined;
    }
}
