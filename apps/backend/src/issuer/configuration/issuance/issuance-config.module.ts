import { Module } from "@nestjs/common";
import { getRepositoryToken, TypeOrmModule } from "@nestjs/typeorm";
import type { Repository } from "typeorm";
import { AuditLogModule } from "../../../audit-log/audit-log.module.js";
import { provideKeyChainReferenceSource } from "../../../crypto/key/key-chain-reference-source.provider.js";
import { RegistrarModule } from "../../../registrar/registrar.module.js";
import { provideFederationTrustAnchorReferenceSource } from "../../../trust/federation-trust-anchor/adapters/federation-trust-anchor-reference-source.provider.js";
import { FederationTrustAnchorModule } from "../../../trust/federation-trust-anchor/federation-trust-anchor.module.js";
import { OutboundUrlPolicyModule } from "../../../webhook/outbound-url-policy.module.js";
import { provideTrustListReferenceSource } from "../../trust-list/trust-list-reference-source.provider.js";
import { TrustListModule } from "../../trust-list/trustlist.module.js";
import { CredentialConfigModule } from "../credentials/credential-config.module.js";
import { TypeOrmIssuanceConfigRepository } from "./adapters/typeorm-issuance-config.repository.js";
import { TypeOrmIssuanceConfigFederationTrustAnchorReferences } from "./adapters/typeorm-issuance-config-federation-trust-anchor-references.js";
import { TypeOrmIssuanceConfigKeyChainReferences } from "./adapters/typeorm-issuance-config-key-chain-references.js";
import { TypeOrmIssuanceConfigTrustListReferences } from "./adapters/typeorm-issuance-config-trust-list-references.js";
import { IssuanceConfig } from "./entities/issuance-config.entity.js";
import { IssuanceService } from "./issuance.service.js";
import { IssuanceConfigController } from "./issuance-config.controller.js";
import { IssuerRegistrationCertificateLock } from "./issuer-registration-certificate-lock.js";
import { ISSUANCE_CONFIG_REPOSITORY } from "./ports/issuance-config.repository.js";

@Module({
    imports: [
        TypeOrmModule.forFeature([IssuanceConfig]),
        AuditLogModule,
        CredentialConfigModule,
        RegistrarModule,
        TrustListModule,
        FederationTrustAnchorModule,
        OutboundUrlPolicyModule,
    ],
    controllers: [IssuanceConfigController],
    providers: [
        IssuanceService,
        IssuerRegistrationCertificateLock,
        {
            provide: ISSUANCE_CONFIG_REPOSITORY,
            inject: [getRepositoryToken(IssuanceConfig)],
            useFactory: (repository: Repository<IssuanceConfig>) =>
                new TypeOrmIssuanceConfigRepository(repository),
        },
        provideTrustListReferenceSource(
            TypeOrmIssuanceConfigTrustListReferences,
            IssuanceConfig,
        ),
        provideFederationTrustAnchorReferenceSource(
            TypeOrmIssuanceConfigFederationTrustAnchorReferences,
            IssuanceConfig,
        ),
        provideKeyChainReferenceSource(
            TypeOrmIssuanceConfigKeyChainReferences,
            IssuanceConfig,
        ),
    ],
    exports: [IssuanceService, IssuerRegistrationCertificateLock],
})
export class IssuanceConfigModule {}
