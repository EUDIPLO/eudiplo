import { Module } from "@nestjs/common";
import { CredentialConfigModule } from "../../issuer/configuration/credentials/credential-config.module.js";
import { TrustListModule } from "../../issuer/trust-list/trustlist.module.js";
import { OutboundUrlPolicyModule } from "../../webhook/outbound-url-policy.module.js";
import { RegistrarModule } from "../registrar.module.js";
import { SchemaMetadataController } from "./schema-metadata.controller.js";
import { SchemaMetadataSubmissionService } from "./schema-metadata-submission.service.js";

/**
 * Management and publishing API for schema metadata.
 *
 * The low-level registrar client remains owned by RegistrarModule; this module
 * composes it with credential configuration and trust-list capabilities.
 */
@Module({
    imports: [
        RegistrarModule,
        CredentialConfigModule,
        TrustListModule,
        OutboundUrlPolicyModule,
    ],
    controllers: [SchemaMetadataController],
    providers: [SchemaMetadataSubmissionService],
})
export class SchemaMetadataModule {}
