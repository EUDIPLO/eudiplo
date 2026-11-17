import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ClientEntity } from "../../auth/client/entities/client.entity.js";
import { TenantEntity } from "../../auth/tenant/entities/tenant.entity.js";
import { KeyChainEntity } from "../../crypto/key/entities/key-chain.entity.js";
import { AttributeProviderEntity } from "../../issuer/configuration/attribute-provider/entities/attribute-provider.entity.js";
import { CredentialConfig } from "../../issuer/configuration/credentials/entities/credential.entity.js";
import { IssuanceConfig } from "../../issuer/configuration/issuance/entities/issuance-config.entity.js";
import { WebhookEndpointEntity } from "../../issuer/configuration/webhook-endpoint/entities/webhook-endpoint.entity.js";
import { StatusListEntity } from "../../issuer/status-list/entities/status-list.entity.js";
import { TrustList } from "../../issuer/trust-list/entities/trust-list.entity.js";
import { FederationTrustAnchorEntity } from "../../trust/federation-trust-anchor/entities/federation-trust-anchor.entity.js";
import { PresentationConfig } from "../../verifier/presentations/entities/presentation-config.entity.js";

/**
 * Repositories shared by ConfigBundleService and ConfigBundleApplyService,
 * grouped so both no longer repeat the same repository injection list.
 */
@Injectable()
export class ConfigBundleRepositories {
    constructor(
        @InjectRepository(TenantEntity)
        readonly tenants: Repository<TenantEntity>,
        @InjectRepository(ClientEntity)
        readonly clients: Repository<ClientEntity>,
        @InjectRepository(KeyChainEntity)
        readonly keyChains: Repository<KeyChainEntity>,
        @InjectRepository(IssuanceConfig)
        readonly issuanceConfigs: Repository<IssuanceConfig>,
        @InjectRepository(CredentialConfig)
        readonly credentialConfigs: Repository<CredentialConfig>,
        @InjectRepository(PresentationConfig)
        readonly presentationConfigs: Repository<PresentationConfig>,
        @InjectRepository(AttributeProviderEntity)
        readonly attributeProviders: Repository<AttributeProviderEntity>,
        @InjectRepository(WebhookEndpointEntity)
        readonly webhookEndpoints: Repository<WebhookEndpointEntity>,
        @InjectRepository(TrustList)
        readonly trustLists: Repository<TrustList>,
        @InjectRepository(FederationTrustAnchorEntity)
        readonly federationTrustAnchors: Repository<FederationTrustAnchorEntity>,
        @InjectRepository(StatusListEntity)
        readonly statusLists: Repository<StatusListEntity>,
    ) {}
}
