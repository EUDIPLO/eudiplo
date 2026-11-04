import { Injectable } from "@nestjs/common";
import { type McpContext, Tool } from "@nestjs/mcp";
import { Role } from "../../auth/roles/role.enum.js";
import { CredentialConfigService } from "../../issuer/configuration/credentials/credential-config/credential-config.service.js";
import type { CredentialConfiguration } from "../../issuer/configuration/credentials/domain/credential-configuration.js";
import { PresentationConfigService } from "../../verifier/presentations/configuration/presentation-config.service.js";
import type { PresentationConfig } from "../../verifier/presentations/entities/presentation-config.entity.js";
import { callerOf, type McpRequest, tenantOf } from "../mcp-caller.js";
import { McpSecured } from "../mcp-secured.decorator.js";

/**
 * Overviews of the tenant's configurations, with the roles of the list
 * endpoints. They name what a configuration issues or requests; the full
 * documents, with claim templates, keys and webhooks, stay in the
 * management API.
 */
@Injectable()
export class ConfigurationTools {
    constructor(
        private readonly credentialConfigs: CredentialConfigService,
        private readonly presentationConfigs: PresentationConfigService,
    ) {}

    @Tool({
        name: "list_credential_configurations",
        title: "List credential configurations",
        description:
            "Lists the credentials the tenant can issue: id, description, display name, format (dc+sd-jwt or mso_mdoc), vct or docType, and whether issued credentials get a status (revocation).",
        annotations: { readOnlyHint: true, openWorldHint: false },
    })
    @McpSecured([Role.Issuances])
    async listCredentialConfigurations(
        _input: unknown,
        context: McpContext<McpRequest>,
    ) {
        const configs = await this.credentialConfigs.get(
            tenantOf(callerOf(context)),
        );
        return configs.map(credentialConfigurationSummary);
    }

    @Tool({
        name: "list_presentation_configurations",
        title: "List presentation configurations",
        description:
            "Lists the tenant's presentation configurations, which define what a presentation request asks a wallet for: id, description, and per requested credential its DCQL query id, format and accepted vct values or docType.",
        annotations: { readOnlyHint: true, openWorldHint: false },
    })
    @McpSecured([Role.Presentations, Role.PresentationRequest])
    async listPresentationConfigurations(
        _input: unknown,
        context: McpContext<McpRequest>,
    ) {
        const configs = await this.presentationConfigs.getPresentationConfigs(
            tenantOf(callerOf(context)),
        );
        return configs.map(presentationConfigurationSummary);
    }
}

function credentialConfigurationSummary(config: CredentialConfiguration) {
    return {
        id: config.id,
        description: config.description ?? null,
        name: config.config.display?.[0]?.name ?? null,
        format: config.config.format,
        vct:
            typeof config.vct === "string"
                ? config.vct
                : (config.vct?.vct ?? null),
        docType: config.config.docType ?? null,
        statusManagement: config.statusManagement ?? false,
    };
}

function presentationConfigurationSummary(config: PresentationConfig) {
    return {
        id: config.id,
        description: config.description ?? null,
        credentials: config.dcql_query.credentials.map((query) => ({
            id: query.id,
            format: query.format,
            ...("vct_values" in query.meta
                ? { vctValues: query.meta.vct_values }
                : { docType: query.meta.doctype_value }),
        })),
    };
}
