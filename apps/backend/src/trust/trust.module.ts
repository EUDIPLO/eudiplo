import { HttpModule, HttpService } from "@nestjs/axios";
import { Module, type Provider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CryptoModule } from "../crypto/crypto.module.js";
import { TrustListModule } from "../issuer/trust-list/trustlist.module.js";
import { outboundFetch } from "../webhook/outbound-fetch.js";
import { OutboundUrlPolicyModule } from "../webhook/outbound-url-policy.module.js";
import { OutboundUrlPolicyService } from "../webhook/outbound-url-policy.service.js";
import {
    HttpFederationResolver,
    TRUST_ENGINE_MAX_BYTES,
    TRUST_ENGINE_TIMEOUT_MS,
} from "./adapters/http-federation-resolver.js";
import { LocalFederationResolver } from "./adapters/local-federation-resolver.js";
import { VerifiedLoteProvider } from "./adapters/verified-lote-provider.js";
import { CollectTrustedEntities } from "./application/collect-trusted-entities.js";
import { CacheController } from "./cache.controller.js";
import {
    FEDERATION_RESOLVER_SETTINGS,
    type FederationResolverSettings,
} from "./federation-resolver-settings.js";
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
import { TrustFetchService } from "./trust-fetch.service.js";
import { TrustStoreService } from "./trust-store.service.js";
import { TRUST_STORE_SETTINGS } from "./trust-store-settings.js";
import { TrustListJwtService } from "./trustlist-jwt.service.js";
import { WalletAttestationService } from "./wallet-attestation.service.js";
import { WALLET_ATTESTATION_SETTINGS } from "./wallet-attestation-settings.js";
import { X509ValidationService } from "./x509-validation.service.js";

/**
 * The federation resolver selected by `FEDERATION_RESOLVER`: local trust
 * chain resolution, or an external trust engine. Both send their requests
 * under the outbound URL policy.
 */
export const federationResolverProvider: Provider = {
    provide: FEDERATION_RESOLVER,
    inject: [
        FEDERATION_RESOLVER_SETTINGS,
        TrustFetchService,
        HttpService,
        OutboundUrlPolicyService,
    ],
    useFactory: (
        settings: FederationResolverSettings,
        trustFetch: TrustFetchService,
        http: HttpService,
        policy: OutboundUrlPolicyService,
    ): FederationResolver =>
        settings.type === "http"
            ? new HttpFederationResolver(
                  settings,
                  outboundFetch(http, policy, {
                      timeoutMs: TRUST_ENGINE_TIMEOUT_MS,
                      maxBytes: TRUST_ENGINE_MAX_BYTES,
                  }),
              )
            : new LocalFederationResolver(
                  trustFetch,
                  settings.clockToleranceSeconds,
              ),
};

@Module({
    imports: [
        CryptoModule,
        TrustListModule,
        OutboundUrlPolicyModule,
        HttpModule,
    ],
    controllers: [CacheController],
    providers: [
        TrustFetchService,
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
        {
            provide: FEDERATION_RESOLVER_SETTINGS,
            inject: [ConfigService],
            useFactory: (config: ConfigService): FederationResolverSettings =>
                config.get<string>("FEDERATION_RESOLVER") === "http"
                    ? {
                          type: "http",
                          url: config.getOrThrow<string>(
                              "FEDERATION_RESOLVER_URL",
                          ),
                          token:
                              config.get<string>("FEDERATION_RESOLVER_TOKEN") ||
                              undefined,
                      }
                    : {
                          type: "local",
                          clockToleranceSeconds:
                              config.getOrThrow<number>("CRYPTO_TOLERANCE"),
                      },
        },
        federationResolverProvider,
        FederationTrustService,
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
