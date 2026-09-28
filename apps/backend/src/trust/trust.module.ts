import * as https from "node:https";
import { HttpModule } from "@nestjs/axios";
import { Module, type Provider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CryptoModule } from "../crypto/crypto.module.js";
import { TrustListModule } from "../issuer/trust-list/trustlist.module.js";
import { OpenIdFederationResolver } from "./adapters/openid-federation-resolver.js";
import { VerifiedLoteProvider } from "./adapters/verified-lote-provider.js";
import { CollectTrustedEntities } from "./application/collect-trusted-entities.js";
import { EvaluateFederationTrustChain } from "./application/evaluate-federation-trust-chain.js";
import { CacheController } from "./cache.controller.js";
import { FederationTrustService } from "./federation-trust.service.js";
import { LoteParserService } from "./lote-parser.service.js";
import {
    FEDERATION_RESOLVER,
    type FederationResolver,
} from "./ports/federation-resolver.js";
import {
    TRUST_LIST_PROVIDER,
    type TrustListProvider,
} from "./ports/trust-list-provider.js";
import { StatusListVerifierService } from "./status-list-verifier.service.js";
import { TrustStoreService } from "./trust-store.service.js";
import { TRUST_STORE_SETTINGS } from "./trust-store-settings.js";
import { TrustListJwtService } from "./trustlist-jwt.service.js";
import { WalletAttestationService } from "./wallet-attestation.service.js";
import { WALLET_ATTESTATION_SETTINGS } from "./wallet-attestation-settings.js";
import { X509ValidationService } from "./x509-validation.service.js";

/**
 * `EvaluateFederationTrustChain` is framework-free and depends on the
 * `FederationResolver` port, so it must be constructed explicitly: a bare
 * class provider would be instantiated without its resolver.
 */
export const evaluateFederationTrustChainProvider: Provider = {
    provide: EvaluateFederationTrustChain,
    inject: [FEDERATION_RESOLVER],
    useFactory: (resolver: FederationResolver) =>
        new EvaluateFederationTrustChain(resolver),
};

@Module({
    imports: [
        HttpModule.register({
            httpsAgent: new https.Agent({
                rejectUnauthorized: process.env.NODE_ENV === "production",
            }),
        }),
        CryptoModule,
        TrustListModule,
    ],
    controllers: [CacheController],
    providers: [
        TrustListJwtService,
        LoteParserService,
        TrustStoreService,
        {
            provide: TRUST_LIST_PROVIDER,
            inject: [TrustListJwtService, LoteParserService],
            useFactory: (jwt: TrustListJwtService, parser: LoteParserService) =>
                new VerifiedLoteProvider(jwt, parser),
        },
        {
            provide: CollectTrustedEntities,
            inject: [TRUST_LIST_PROVIDER],
            useFactory: (lists: TrustListProvider) =>
                new CollectTrustedEntities(lists),
        },
        {
            provide: TRUST_STORE_SETTINGS,
            inject: [ConfigService],
            useFactory: (config: ConfigService) => ({
                publicUrl: config.getOrThrow<string>("PUBLIC_URL"),
                internalUrl: config.get<string>("INTERNAL_URL"),
            }),
        },
        {
            provide: WALLET_ATTESTATION_SETTINGS,
            inject: [ConfigService],
            useFactory: (config: ConfigService) => ({
                cryptoToleranceSeconds:
                    config.getOrThrow<number>("CRYPTO_TOLERANCE"),
            }),
        },
        X509ValidationService,
        StatusListVerifierService,
        WalletAttestationService,
        FederationTrustService,
        evaluateFederationTrustChainProvider,
        OpenIdFederationResolver,
        {
            provide: FEDERATION_RESOLVER,
            useExisting: OpenIdFederationResolver,
        },
    ],
    exports: [
        TrustStoreService,
        X509ValidationService,
        StatusListVerifierService,
        WalletAttestationService,
        FederationTrustService,
    ],
})
export class TrustModule {}
