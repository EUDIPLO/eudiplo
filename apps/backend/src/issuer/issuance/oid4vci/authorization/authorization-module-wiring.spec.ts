import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { describe, expect, it, vi } from "vitest";
import { CryptoService } from "../../../../crypto/crypto.service.js";
import { KeyChainService } from "../../../../crypto/key/key-chain.service.js";
import { CreateSession } from "../../../../session/application/create-session.js";
import { RecordFailedTxCodeAttempt } from "../../../../session/application/record-failed-tx-code-attempt.js";
import { SessionStore } from "../../../../session/application/session-store.js";
import { SessionConfigService } from "../../../../session/session-config.service.js";
import { WalletAttestationService } from "../../../../trust/wallet-attestation.service.js";
import { IssuanceService } from "../../../configuration/issuance/issuance.service.js";
import { StatusListConfigService } from "../../../status-list/status-list-config.service.js";
import { OID4VCI_SETTINGS } from "../oid4vci-settings.js";
import { AuthorizePushedRequest } from "./application/authorize-pushed-request.js";
import { BuildBuiltInAuthorizationServerMetadata } from "./application/build-built-in-authorization-server-metadata.js";
import { ExchangeAccessToken } from "./application/exchange-access-token.js";
import { PushAuthorizationRequest } from "./application/push-authorization-request.js";
import { builtInAuthorizationServerProviders } from "./authorization.module.js";

describe("AuthorizationModule wiring", () => {
    it("constructs the built-in authorization server use cases from their ports", async () => {
        const moduleRef = await Test.createTestingModule({
            providers: [
                ...builtInAuthorizationServerProviders,
                {
                    provide: ConfigService,
                    useValue: {
                        getOrThrow: () => "https://issuer.example",
                        get: () => undefined,
                    },
                },
                {
                    provide: CryptoService,
                    useValue: { getCallbackContext: vi.fn(() => ({})) },
                },
                {
                    provide: IssuanceService,
                    useValue: {
                        getIssuanceConfiguration: vi
                            .fn()
                            .mockResolvedValue({ authorizationServers: [] }),
                    },
                },
                {
                    provide: StatusListConfigService,
                    useValue: {
                        getEffectiveConfig: vi
                            .fn()
                            .mockResolvedValue({ enableAggregation: true }),
                    },
                },
                {
                    provide: SessionConfigService,
                    useValue: {
                        getEffectiveTtlSeconds: vi
                            .fn()
                            .mockResolvedValue(86400),
                    },
                },
                { provide: WalletAttestationService, useValue: {} },
                { provide: KeyChainService, useValue: {} },
                { provide: SessionStore, useValue: {} },
                { provide: RecordFailedTxCodeAttempt, useValue: {} },
                { provide: CreateSession, useValue: {} },
            ],
        }).compile();

        expect(moduleRef.get(OID4VCI_SETTINGS)).toEqual({
            publicUrl: "https://issuer.example",
            internalUrl: undefined,
        });
        expect(moduleRef.get(ExchangeAccessToken)).toBeInstanceOf(
            ExchangeAccessToken,
        );
        expect(moduleRef.get(PushAuthorizationRequest)).toBeInstanceOf(
            PushAuthorizationRequest,
        );
        expect(moduleRef.get(AuthorizePushedRequest)).toBeInstanceOf(
            AuthorizePushedRequest,
        );
        await expect(
            moduleRef
                .get(BuildBuiltInAuthorizationServerMetadata)
                .execute("t1"),
        ).resolves.toMatchObject({
            issuer: "https://issuer.example/issuers/t1",
            status_list_aggregation_endpoint:
                "https://issuer.example/issuers/t1/status-management/status-list-aggregation",
        });
    });
});
