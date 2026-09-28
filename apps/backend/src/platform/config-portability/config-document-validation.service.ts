import { resourceId } from "@eudiplo/config-format/config-format.js";
import { Injectable } from "@nestjs/common";
import type { z } from "zod";
import { CreateClientSchema } from "../../auth/client/schemas/client.schema.js";
import { UpdateTenantSchema } from "../../auth/tenant/schemas/create-tenant.schema.js";
import { KeyChainImportSchema } from "../../crypto/key/schemas/key-chain.schema.js";
import { KmsConfigSchema } from "../../crypto/key/schemas/kms-config.schema.js";
import { KeyUsageType } from "../../crypto/key/types/key-usage-type.js";
import { CreateAttributeProviderSchema } from "../../issuer/configuration/attribute-provider/schemas/attribute-provider.schema.js";
import { CredentialConfigCreateSchema } from "../../issuer/configuration/credentials/schemas/credential-config.schema.js";
import { IssuanceConfigSchema } from "../../issuer/configuration/issuance/schemas/issuance.schema.js";
import { CreateWebhookEndpointSchema } from "../../issuer/configuration/webhook-endpoint/schemas/webhook-endpoint.schema.js";
import { StatusListImportSchema } from "../../issuer/status-list/dto/status-list.schema.js";
import { TrustListCreateSchema } from "../../issuer/trust-list/schemas/trust-list.schema.js";
import { CreateRegistrarConfigSchema } from "../../registrar/schemas/registrar.schema.js";
import { PresentationConfigCreateSchema } from "../../verifier/presentations/schemas/presentation-config.schema.js";
import { ConfigMigrationService } from "./config-migration.service.js";
import type {
    ConfigDocument,
    ConfigMigrationIssue,
    ConfigResourceKind,
} from "./config-resource.types.js";

@Injectable()
export class ConfigDocumentValidationService {
    constructor(private readonly migrationService: ConfigMigrationService) {}

    validate(document: ConfigDocument): ConfigMigrationIssue[] {
        const identityField =
            document.kind === "Client"
                ? (document.spec as Record<string, unknown>).clientId
                : (document.spec as Record<string, unknown>).id;
        const identityIssues: ConfigMigrationIssue[] = [];
        if (
            typeof identityField === "string" &&
            identityField !== resourceId(document)
        ) {
            identityIssues.push({
                severity: "error",
                code: "RESOURCE_ID_MISMATCH",
                path:
                    document.kind === "Client" ? "/spec/clientId" : "/spec/id",
                message: `Resource id '${identityField}' does not match envelope id '${resourceId(document)}'.`,
                resource: {
                    kind: document.kind,
                    id: resourceId(document),
                },
            });
        }
        if (document.kind === "KeyChain") {
            identityIssues.push(...this.validatePortableKeyChain(document));
        }
        const schema = this.schema(document.kind, document);
        if (!schema) return identityIssues;
        const value =
            document.kind === "KeyChain"
                ? this.migrationService.unwrapForLegacyImporter(document)
                : document.spec;
        const result = schema.safeParse(value);
        if (result.success) return identityIssues;
        return identityIssues.concat(
            result.error.issues.map((issue) => ({
                severity: "error" as const,
                code: "CURRENT_SCHEMA_VALIDATION_FAILED",
                path: `/spec/${issue.path.join("/")}`,
                message: issue.message,
                resource: {
                    kind: document.kind,
                    id: resourceId(document),
                },
            })),
        );
    }

    private validatePortableKeyChain(
        document: ConfigDocument,
    ): ConfigMigrationIssue[] {
        const spec = document.spec as Record<string, any>;
        const issues: ConfigMigrationIssue[] = [];
        const issue = (code: string, path: string, message: string) =>
            issues.push({
                severity: "error",
                code,
                path,
                message,
                resource: {
                    kind: document.kind,
                    id: resourceId(document),
                },
            });
        if (!Object.values(KeyUsageType).includes(spec.usageType)) {
            issue(
                "INVALID_KEY_USAGE_TYPE",
                "/spec/usageType",
                "A supported key-chain usageType is required.",
            );
        }
        const source = spec.keySource;
        if (
            !source ||
            ![
                "required",
                "regenerate",
                "private-jwk",
                "external-reference",
            ].includes(source.type)
        ) {
            issue(
                "INVALID_KEY_SOURCE",
                "/spec/keySource/type",
                "Choose required, regenerate, private-jwk, or external-reference.",
            );
        }
        if (
            source?.type === "regenerate" &&
            source.keyChainType !== undefined &&
            !["standalone", "internalChain"].includes(source.keyChainType)
        ) {
            issue(
                "INVALID_KEY_CHAIN_TYPE",
                "/spec/keySource/keyChainType",
                "keyChainType must be standalone or internalChain.",
            );
        }
        if (
            source?.type === "external-reference" &&
            (!source.provider ||
                !source.externalKeyId ||
                !source.publicJwk ||
                typeof source.publicJwk !== "object")
        ) {
            issue(
                "INVALID_EXTERNAL_KEY_REFERENCE",
                "/spec/keySource",
                "provider, externalKeyId, and publicJwk are required for an external key reference.",
            );
        }
        return issues;
    }

    normalizeForComparison(document: ConfigDocument): Record<string, unknown> {
        if (document.kind === "KeyChain") return structuredClone(document.spec);
        const result = this.schema(document.kind, document)?.safeParse(
            structuredClone(document.spec),
        );
        return result?.success
            ? (result.data as Record<string, unknown>)
            : structuredClone(document.spec);
    }

    private schema(
        kind: ConfigResourceKind,
        document: ConfigDocument,
    ): z.ZodType | undefined {
        switch (kind) {
            case "Tenant":
                return UpdateTenantSchema;
            case "Client":
                return CreateClientSchema;
            case "KmsConfig":
                return KmsConfigSchema;
            case "KeyChain":
                return (document.spec as any).keySource?.type === "private-jwk"
                    ? KeyChainImportSchema
                    : undefined;
            case "RegistrarConfig":
                return CreateRegistrarConfigSchema;
            case "IssuanceConfig":
                return IssuanceConfigSchema;
            case "CredentialConfig":
                return CredentialConfigCreateSchema;
            case "PresentationConfig":
                return PresentationConfigCreateSchema;
            case "AttributeProvider":
                return CreateAttributeProviderSchema;
            case "WebhookEndpoint":
                return CreateWebhookEndpointSchema;
            case "TrustList":
                return TrustListCreateSchema;
            case "StatusList":
                return StatusListImportSchema;
        }
    }
}
