import { HttpModule } from "@nestjs/axios";
import { Module } from "@nestjs/common";
import { CryptoModule } from "../../crypto/crypto.module.js";
import { IssuanceConfigModule } from "../../issuer/configuration/issuance/issuance-config.module.js";
import { PresentationsModule } from "../../verifier/presentations/presentations.module.js";
import { OutboundUrlPolicyModule } from "../../webhook/outbound-url-policy.module.js";
import { EudiHubClient } from "./eudi-hub.client.js";
import { EudiHubController } from "./eudi-hub.controller.js";
import { EudiHubService } from "./eudi-hub.service.js";
import { EudiHubRegistrationService } from "./eudi-hub-registration.service.js";

/**
 * Requests to the German EUDI Hub with an access token pasted from its
 * portal: access certificates for access key chains, and registration
 * certificates stored in presentation and issuance configurations.
 */
@Module({
    imports: [
        CryptoModule,
        HttpModule,
        OutboundUrlPolicyModule,
        IssuanceConfigModule,
        PresentationsModule,
    ],
    controllers: [EudiHubController],
    providers: [EudiHubClient, EudiHubService, EudiHubRegistrationService],
})
export class EudiHubModule {}
