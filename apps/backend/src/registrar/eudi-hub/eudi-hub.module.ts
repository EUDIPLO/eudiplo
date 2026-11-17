import { HttpModule } from "@nestjs/axios";
import { Module } from "@nestjs/common";
import { OutboundUrlPolicyModule } from "../../webhook/outbound-url-policy.module.js";
import { RegistrarStorageModule } from "../registrar-storage.module.js";
import { EudiHubClient } from "./eudi-hub.client.js";
import { EudiHubController } from "./eudi-hub.controller.js";
import { EudiHubService } from "./eudi-hub.service.js";
import { EudiHubRegistrationService } from "./eudi-hub-registration.service.js";

/**
 * Registrar adapter for the German EUDI Hub. Requests access certificates
 * for access key chains and registration certificates for presentation and
 * issuance configurations with an access token pasted from its portal, and
 * stores them through {@link RegistrarStorageModule}.
 */
@Module({
    imports: [HttpModule, OutboundUrlPolicyModule, RegistrarStorageModule],
    controllers: [EudiHubController],
    providers: [EudiHubClient, EudiHubService, EudiHubRegistrationService],
})
export class EudiHubModule {}
