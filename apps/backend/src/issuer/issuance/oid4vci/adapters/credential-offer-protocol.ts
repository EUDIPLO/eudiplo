import type { TraceService } from "nestjs-otel";
import type { CredentialsService } from "../../../configuration/credentials/credentials.service.js";
import { InvalidCredentialOffer } from "../domain/credential-offer-errors.js";
import type { Oid4vciSettings } from "../oid4vci-settings.js";
import type { CredentialOfferProtocol } from "../ports/credential-offer-protocol.js";
import type { Oid4vciProtocolMetadata } from "./oid4vci-protocol-metadata.js";

export class OpenIdCredentialOfferProtocol implements CredentialOfferProtocol {
    constructor(
        private readonly metadata: Oid4vciProtocolMetadata,
        private readonly credentials: CredentialsService,
        private readonly trace: TraceService,
        private readonly settings: Oid4vciSettings,
    ) {}
    async selectAuthorizationServer(tenantId: string, selected?: string) {
        const selection =
            await this.metadata.resolveAuthorizationServerSelection(
                tenantId,
                selected,
            );
        return {
            issuer:
                selection ??
                (await this.metadata.getAuthorizationServer(tenantId)),
            sessionServerId:
                selection ??
                (
                    await this.metadata.getSelectedAuthorizationServerConfig(
                        tenantId,
                    )
                )?.id,
        };
    }
    validateClaims(
        tenantId: string,
        configurationId: string,
        claims: Record<string, unknown>,
    ) {
        return this.credentials.validateClaimsForCredential(
            configurationId,
            claims,
            tenantId,
        );
    }
    async encode(
        ...[session, configurationIds, grants]: Parameters<
            CredentialOfferProtocol["encode"]
        >
    ) {
        this.trace.getSpan()?.setAttributes({
            "session.id": session.id,
            "session.tenantId": session.tenantId,
            "oid4vci.flow": session.credentialPayload!.flow,
            "oid4vci.credentialConfigurationIds": configurationIds.join(","),
        });
        const issuer = this.metadata.getIssuer(session.tenantId, session.id);
        const issuerMetadata = await this.metadata.issuerMetadata(
            session.tenantId,
            issuer,
        );
        try {
            const offer = await issuer.createCredentialOffer({
                credentialConfigurationIds: configurationIds,
                grants,
                issuerMetadata,
                credentialOfferUri: `${this.settings.publicUrl}/issuers/${session.tenantId}/vci/credential-offers/${session.id}`,
            });
            return {
                object: offer.credentialOfferObject,
                uri: offer.credentialOffer,
            };
        } catch {
            throw new InvalidCredentialOffer();
        }
    }
}
