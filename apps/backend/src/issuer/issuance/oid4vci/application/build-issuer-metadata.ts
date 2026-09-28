import type { AuthorizationServerMetadata } from "@openid4vc/oauth2";
import {
    type IssuerMetadataResult,
    type Openid4vciIssuer,
    Openid4vciVersion,
} from "@openid4vc/openid4vci";
import type { FederationTrustSource } from "../../../../trust/types.js";
import type { IssuanceConfiguration } from "../../../configuration/issuance/domain/issuance-configuration.js";
import type { IssuanceConfigRepository } from "../../../configuration/issuance/ports/issuance-config.repository.js";
import {
    authorizationServerIssuer,
    toAuthorizationServerEndpoint,
} from "../domain/authorization-server-endpoint.js";
import type {
    ExternalAuthorizationServerMetadataResolver,
    HostedAuthorizationServerMetadata,
} from "../ports/authorization-server-metadata.js";
import type { IssuerMetadataSources } from "../ports/issuer-metadata-sources.js";
import type { IssuerRegistrationCertificateProvider } from "../ports/issuer-registration-certificate-provider.js";

type MetadataFactory = Pick<Openid4vciIssuer, "createCredentialIssuerMetadata">;

/**
 * Assembles the OID4VCI credential issuer metadata of a tenant together with
 * the metadata of every advertised authorization server.
 */
export class BuildIssuerMetadata {
    constructor(
        private readonly issuanceConfigs: Pick<
            IssuanceConfigRepository,
            "getForTenant"
        >,
        private readonly hostedServers: HostedAuthorizationServerMetadata,
        private readonly externalServers: ExternalAuthorizationServerMetadataResolver,
        private readonly sources: IssuerMetadataSources,
        private readonly registrationCertificates: IssuerRegistrationCertificateProvider,
        private readonly publicUrl: string,
    ) {}

    async execute(
        tenantId: string,
        issuer: MetadataFactory,
    ): Promise<IssuerMetadataResult> {
        const credential_issuer = `${this.publicUrl}/issuers/${tenantId}`;
        const config = await this.issuanceConfigs.getForTenant(tenantId);

        const { issuers, metadata } = await this.resolveAuthorizationServers(
            tenantId,
            credential_issuer,
            config,
        );

        const registrationCertificate = config.registrationCertificate?.enabled
            ? await this.registrationCertificates.resolve(
                  tenantId,
                  config.registrationCertificate,
              )
            : undefined;

        const credentialIssuer = issuer.createCredentialIssuerMetadata({
            credential_issuer,
            credential_configurations_supported:
                await this.sources.credentialConfigurationsSupported(tenantId),
            credential_endpoint: `${credential_issuer}/vci/credential`,
            deferred_credential_endpoint: `${credential_issuer}/vci/deferred_credential`,
            authorization_servers: issuers,
            notification_endpoint:
                config.notificationEndpointEnabled !== false
                    ? `${credential_issuer}/vci/notification`
                    : undefined,
            nonce_endpoint: `${credential_issuer}/vci/nonce`,
            display: config.display !== null ? config.display : undefined,
            credential_request_encryption: {
                jwks: {
                    keys: [
                        await this.sources.credentialRequestEncryptionKey(
                            tenantId,
                        ),
                    ],
                },
                enc_values_supported: ["A128GCM", "A256GCM"],
                encryption_required: !!config.credentialRequestEncryption,
            },
            credential_response_encryption: {
                alg_values_supported: ["ECDH-ES"],
                enc_values_supported: ["A128GCM", "A256GCM"],
                encryption_required: !!config.credentialResponseEncryption,
            },
            batch_credential_issuance:
                config.batchSize && config.batchSize > 1
                    ? { batch_size: config.batchSize }
                    : undefined,
            issuer_info: registrationCertificate
                ? [
                      {
                          format: "registration_cert",
                          data: registrationCertificate,
                      },
                  ]
                : undefined,
        });

        return {
            credentialIssuer,
            authorizationServers: metadata,
            originalDraftVersion: Openid4vciVersion.V1,
        } as IssuerMetadataResult;
    }

    /**
     * Enabled authorization servers in configuration order, without
     * duplicates. External servers are checked against the federation trust
     * policy before their metadata is fetched.
     */
    private async resolveAuthorizationServers(
        tenantId: string,
        credentialIssuer: string,
        config: IssuanceConfiguration,
    ): Promise<{ issuers: string[]; metadata: AuthorizationServerMetadata[] }> {
        const federation = federationTrustSource(config);
        const issuers: string[] = [];
        const metadata: AuthorizationServerMetadata[] = [];

        for (const server of config.authorizationServers ?? []) {
            if (server.enabled === false) continue;
            const endpoint = toAuthorizationServerEndpoint(server);
            if (!endpoint) continue;

            const issuer = authorizationServerIssuer(
                endpoint,
                credentialIssuer,
            );
            if (issuers.includes(issuer)) continue;

            const serverMetadata =
                endpoint.kind === "external"
                    ? await this.externalServers.resolve(issuer, federation)
                    : await this.hostedServers.get(tenantId, endpoint);
            issuers.push(issuer);
            metadata.push(serverMetadata);
        }

        return { issuers, metadata };
    }
}

function federationTrustSource(
    config: IssuanceConfiguration,
): FederationTrustSource | undefined {
    const federation = config.federation;
    if (!federation?.trustAnchors?.length) return undefined;
    return {
        mode: federation.mode,
        entityId: federation.entityId,
        trustAnchors: federation.trustAnchors,
        cacheTtlSeconds: federation.cacheTtlSeconds,
        enforceSigningPolicy: federation.enforceSigningPolicy,
    } as FederationTrustSource;
}
