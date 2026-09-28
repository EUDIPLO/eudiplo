import type { TraceService } from "nestjs-otel";
import type { CredentialsService } from "../../../configuration/credentials/credentials.service.js";
import type { BuildIssuerMetadata } from "../application/build-issuer-metadata.js";
import { InvalidCredentialOffer } from "../domain/credential-offer-errors.js";
import type { Oid4vciSdkFactory } from "../oid4vci-sdk.factory.js";
import type { Oid4vciSettings } from "../oid4vci-settings.js";
import type { CredentialOfferProtocol } from "../ports/credential-offer-protocol.js";

export class OpenIdCredentialOfferProtocol implements CredentialOfferProtocol {
    constructor(
        private readonly sdk: Oid4vciSdkFactory,
        private readonly buildIssuerMetadata: BuildIssuerMetadata,
        private readonly credentials: CredentialsService,
        private readonly trace: TraceService,
        private readonly settings: Oid4vciSettings,
    ) {}
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
        const issuer = this.sdk.issuer(session.tenantId, session.id);
        const issuerMetadata = await this.buildIssuerMetadata.execute(
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
