import { resourceId } from "@eudiplo/config-format/config-format.js";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { z } from "zod";
import { CreateClientSchema } from "../../auth/client/schemas/client.schema.js";
import { UpdateTenantSchema } from "../../auth/tenant/schemas/create-tenant.schema.js";
import { DefaultKeyChainsSchema } from "../../auth/tenant/schemas/key-chain-defaults.schema.js";
import { KEY_CHAIN_TYPES } from "../../crypto/key/domain/key-chain-import-type.js";
import { KeyChainImportSchema } from "../../crypto/key/schemas/key-chain.schema.js";
import { KmsConfigSchema } from "../../crypto/key/schemas/kms-config.schema.js";
import { KeyUsageType } from "../../crypto/key/types/key-usage-type.js";
import { CreateAttributeProviderSchema } from "../../issuer/configuration/attribute-provider/schemas/attribute-provider.schema.js";
import { CredentialConfigCreateSchema } from "../../issuer/configuration/credentials/schemas/credential-config.schema.js";
import { IssuanceConfigSchema } from "../../issuer/configuration/issuance/schemas/issuance.schema.js";
import { CreateWebhookEndpointSchema } from "../../issuer/configuration/webhook-endpoint/schemas/webhook-endpoint.schema.js";
import { StatusListImportSchema } from "../../issuer/status-list/dto/status-list.schema.js";
import { TrustListCreateSchema } from "../../issuer/trust-list/schemas/trust-list.schema.js";
import { checkRegistrationCertificate } from "../../registrar/domain/registration-certificate-check.js";
import { CreateRegistrarConfigSchema } from "../../registrar/schemas/registrar.schema.js";
import { CreateFederationTrustAnchorSchema } from "../../trust/federation-trust-anchor/schemas/federation-trust-anchor.schema.js";
import { resolveDcqlTenantUrl } from "../../verifier/presentations/domain/dcql-tenant-url.js";
import { missingTrustedAuthorities } from "../../verifier/presentations/domain/trusted-authority-requirement.js";
import { PresentationConfigCreateSchema } from "../../verifier/presentations/schemas/presentation-config.schema.js";
import { ConfigMigrationService } from "./config-migration.service.js";
import type {
    ConfigDocument,
    ConfigMigrationIssue,
    ConfigResourceKind,
} from "./config-resource.types.js";
import {
    internalChainProblems,
    isInternalChainWithPrivateKeys,
    keySourceKeyChainType,
} from "./key-chain-document.js";

/** A `${VAR}` placeholder the plan reports as SECRET_REQUIRED. */
export const UNRESOLVED_PLACEHOLDER = /^\$\{[A-Z0-9_]+(?::[^}]*)?\}$/;

/** The flat `registrationCertImportJwt` form field, trimmed, if it is a string. */
function flatImportJwt(spec: Record<string, any>): string | undefined {
    const value = spec.registrationCertImportJwt;
    return typeof value === "string" ? value.trim() : undefined;
}

@Injectable()
export class ConfigDocumentValidationService {
    constructor(
        private readonly migrationService: ConfigMigrationService,
        private readonly configService: ConfigService,
    ) {}

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
        if (document.kind === "PresentationConfig") {
            identityIssues.push(...this.validateTrustedAuthorities(document));
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
            !KEY_CHAIN_TYPES.includes(source.keyChainType)
        ) {
            issue(
                "INVALID_KEY_CHAIN_TYPE",
                "/spec/keySource/keyChainType",
                "keyChainType must be standalone or internalChain.",
            );
        }
        const sourceType = keySourceKeyChainType(spec);
        if (spec.type !== undefined && sourceType && spec.type !== sourceType) {
            issue(
                "KEY_CHAIN_TYPE_MISMATCH",
                "/spec/type",
                `type '${spec.type}' contradicts the key source, which describes a ${sourceType} key chain.`,
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
        if (isInternalChainWithPrivateKeys(spec)) {
            for (const problem of internalChainProblems(spec))
                issue(problem.code, problem.path, problem.message);
        }
        return issues;
    }

    /**
     * Every DCQL credential query needs a trusted authority unless
     * `SKIP_TRUST_AUTHORITY` is set, so the plan reports what apply would
     * reject.
     */
    private validateTrustedAuthorities(
        document: ConfigDocument,
    ): ConfigMigrationIssue[] {
        const credentials = (document.spec as Record<string, any>).dcql_query
            ?.credentials;
        if (!Array.isArray(credentials)) return [];
        const violation = missingTrustedAuthorities(
            credentials.filter(
                (credential) => credential && typeof credential === "object",
            ),
            this.configService.get<boolean>("SKIP_TRUST_AUTHORITY") ?? false,
        );
        if (!violation) return [];
        return [
            {
                severity: "error",
                code: "TRUSTED_AUTHORITY_REQUIRED",
                path: "/spec/dcql_query/credentials",
                message: violation,
                resource: {
                    kind: document.kind,
                    id: resourceId(document),
                },
            },
        ];
    }

    /**
     * An imported `registration_cert.jwt` must be valid now and authorize the
     * DCQL query with `<TENANT_URL>` resolved for `tenantId`, the tenant the
     * bundle is applied to, as saving the presentation config checks. The
     * plan calls this only for documents apply writes: an unchanged or
     * skipped document is not saved, so a certificate that expired since
     * does not block the import.
     */
    validateRegistrationCertificate(
        document: ConfigDocument,
        tenantId: string,
    ): ConfigMigrationIssue[] {
        if (document.kind !== "PresentationConfig") return [];
        const spec = document.spec as Record<string, any>;
        // The schema has not validated the document yet, so read only the
        // JWT: `registration_cert.jwt`, or the flat form field the
        // presentation config service turns into it.
        const jwt = Object.hasOwn(spec, "registration_cert")
            ? spec.registration_cert?.jwt
            : flatImportJwt(spec);
        // An unresolved `${VAR}` placeholder is reported as SECRET_REQUIRED.
        if (
            typeof jwt !== "string" ||
            jwt.length === 0 ||
            UNRESOLVED_PLACEHOLDER.test(jwt)
        ) {
            return [];
        }
        const { problem } = checkRegistrationCertificate(
            jwt,
            resolveDcqlTenantUrl(
                spec.dcql_query,
                this.configService.getOrThrow<string>("PUBLIC_URL"),
                tenantId,
            ),
            {
                skipOveraskingCheck:
                    this.configService.get<boolean>("SKIP_OVERASKING_CHECK") ??
                    false,
            },
        );
        if (!problem) return [];
        return [
            {
                severity: "error",
                code: "REGISTRATION_CERTIFICATE_REFUSED",
                path: "/spec/registration_cert",
                message: problem.message,
                resource: {
                    kind: document.kind,
                    id: resourceId(document),
                },
            },
        ];
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
            case "KeyChain": {
                // Only a private key without activeJwk goes through the key
                // chain importer, so only that shape needs its request schema.
                const spec = document.spec as Record<string, any>;
                return spec.keySource?.type === "private-jwk" &&
                    !isInternalChainWithPrivateKeys(spec)
                    ? KeyChainImportSchema
                    : undefined;
            }
            case "KeyChainDefaults":
                return DefaultKeyChainsSchema;
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
            case "FederationTrustAnchor":
                return CreateFederationTrustAnchorSchema;
            case "StatusList":
                return StatusListImportSchema;
        }
    }
}
