import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { CryptoModule } from "../../crypto/crypto.module.js";
import { WebhookEndpointEntity } from "../../issuer/configuration/webhook-endpoint/entities/webhook-endpoint.entity.js";
import { RegistrarModule } from "../../registrar/registrar.module.js";
import { UpdateSessionForTenant } from "../../session/application/update-session-for-tenant.js";
import { UpdateUnconsumedSession } from "../../session/application/update-unconsumed-session.js";
import { SessionModule } from "../../session/session.module.js";
import {
    PRESENTATION_RESULT_PUBLISHER,
    type PresentationResultPublisher,
} from "../../webhook/ports/presentation-result-publisher.js";
import { WebhookModule } from "../../webhook/webhook.module.js";
import { PresentationsModule } from "../presentations/presentations.module.js";
import { CompletePresentationResponse } from "./application/complete-presentation-response.js";
import { FailPresentationResponse } from "./application/fail-presentation-response.js";
import { ParseAuthorizationResponse } from "./application/parse-authorization-response.js";
import { ProcessVerifiedPresentation } from "./application/process-verified-presentation.js";
import { RetrievePresentationRequest } from "./application/retrieve-presentation-request.js";
import { Oid4vpController } from "./oid4vp.controller.js";
import { Oid4vpService } from "./oid4vp.service.js";
import { OID4VP_SETTINGS } from "./oid4vp-settings.js";

@Module({
    imports: [
        CryptoModule,
        RegistrarModule,
        SessionModule,
        WebhookModule,
        TypeOrmModule.forFeature([WebhookEndpointEntity]),
        PresentationsModule,
    ],
    controllers: [Oid4vpController],
    providers: [
        Oid4vpService,
        {
            provide: OID4VP_SETTINGS,
            inject: [ConfigService],
            useFactory: (config: ConfigService) => ({
                publicUrl: config.getOrThrow<string>("PUBLIC_URL"),
                removeTrustedAuthorities:
                    config.get<boolean>("VP_REMOVE_TA") ?? false,
                logDecryptedResponse:
                    config.get<boolean>("LOG_OID4VP_DECRYPTED_RESPONSE") ??
                    false,
            }),
        },
        ParseAuthorizationResponse,
        {
            provide: ProcessVerifiedPresentation,
            inject: [
                ParseAuthorizationResponse,
                CompletePresentationResponse,
                PRESENTATION_RESULT_PUBLISHER,
            ],
            useFactory: (
                state: ParseAuthorizationResponse,
                complete: CompletePresentationResponse,
                publisher: PresentationResultPublisher,
            ) => new ProcessVerifiedPresentation(state, complete, publisher),
        },
        {
            provide: FailPresentationResponse,
            inject: [UpdateSessionForTenant],
            useFactory: (sessions: UpdateSessionForTenant) =>
                new FailPresentationResponse(sessions),
        },
        {
            provide: CompletePresentationResponse,
            inject: [UpdateUnconsumedSession],
            useFactory: (update: UpdateUnconsumedSession) =>
                new CompletePresentationResponse(update),
        },
        {
            provide: RetrievePresentationRequest,
            inject: [UpdateSessionForTenant],
            useFactory: (updateSession: UpdateSessionForTenant) =>
                new RetrievePresentationRequest(updateSession),
        },
    ],
    exports: [Oid4vpService],
})
export class Oid4vpModule {}
