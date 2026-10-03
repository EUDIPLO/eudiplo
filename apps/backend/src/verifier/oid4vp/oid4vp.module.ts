import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { CryptoModule } from "../../crypto/crypto.module.js";
import { WebhookEndpointEntity } from "../../issuer/configuration/webhook-endpoint/entities/webhook-endpoint.entity.js";
import { RegistrarModule } from "../../registrar/registrar.module.js";
import { ChangeSessionState } from "../../session/application/change-session-state.js";
import { SessionStore } from "../../session/application/session-store.js";
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
            inject: [
                SessionStore,
                ChangeSessionState,
                PRESENTATION_RESULT_PUBLISHER,
            ],
            useFactory: (
                sessions: SessionStore,
                state: ChangeSessionState,
                publisher: PresentationResultPublisher,
            ) => new FailPresentationResponse(sessions, state, publisher),
        },
        {
            provide: CompletePresentationResponse,
            inject: [SessionStore, ChangeSessionState],
            useFactory: (sessions: SessionStore, state: ChangeSessionState) =>
                new CompletePresentationResponse(sessions, state),
        },
        {
            provide: RetrievePresentationRequest,
            inject: [SessionStore, ChangeSessionState],
            useFactory: (sessions: SessionStore, state: ChangeSessionState) =>
                new RetrievePresentationRequest(sessions, state),
        },
    ],
    exports: [Oid4vpService],
})
export class Oid4vpModule {}
