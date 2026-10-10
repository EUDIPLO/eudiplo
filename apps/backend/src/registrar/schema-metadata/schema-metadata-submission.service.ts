import { BadRequestException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SchemaURIMeta } from "@owf/eudi-attestation-schema";
import { KeyChainService } from "../../crypto/key/key-chain.service.js";
import { CredentialConfigService } from "../../issuer/configuration/credentials/credential-config/credential-config.service.js";
import {
    SchemaMetadataPinMode,
    SignSchemaMetaConfigDto,
    SignVersionSchemaMetaConfigDto,
} from "../../issuer/configuration/credentials/dto/schema-meta-config.dto.js";
import { buildJsonSchema } from "../../issuer/configuration/credentials/utils/index.js";
import { TrustListService } from "../../issuer/trust-list/trustlist.service.js";
import {
    type OutboundFinalResponse,
    OutboundUrlPolicyService,
} from "../../webhook/outbound-url-policy.service.js";
import { type CreateSchemaMetadataMultipartDto } from "../generated/index.js";
import {
    REMOTE_FILE_MAX_BYTES,
    REMOTE_FILE_TIMEOUT_MS,
} from "../registrar-http.js";
import { type UpdateSchemaMetadataDto } from "./dto/schema-metadata.dto.js";
import { SchemaMetadataService } from "./schema-metadata.service.js";

type TrustedAuthorityInput = NonNullable<
    SignSchemaMetaConfigDto["config"]["trustedAuthorities"]
>[number];

type RegistrarMetadataPayload = CreateSchemaMetadataMultipartDto;

/** Redirects followed when fetching rulebooks and schemas referenced by URL. */
const REMOTE_FILE_MAX_REDIRECTS = 3;

@Injectable()
export class SchemaMetadataSubmissionService {
    constructor(
        private readonly credentialsService: CredentialConfigService,
        private readonly schemaMetadataService: SchemaMetadataService,
        private readonly trustListService: TrustListService,
        private readonly keyChainService: KeyChainService,
        private readonly configService: ConfigService,
        private readonly outboundUrlPolicy: OutboundUrlPolicyService,
    ) {}

    private extractConfiguredVct(credentialConfig: {
        vct?: unknown;
    }): string | undefined {
        if (typeof credentialConfig.vct === "string") {
            return credentialConfig.vct;
        }

        if (
            credentialConfig.vct &&
            typeof credentialConfig.vct === "object" &&
            "vct" in credentialConfig.vct &&
            typeof (credentialConfig.vct as { vct?: unknown }).vct === "string"
        ) {
            return (credentialConfig.vct as { vct: string }).vct;
        }

        return undefined;
    }

    private deriveSchemaUriMetadata(
        credentialConfig: Awaited<
            ReturnType<CredentialConfigService["getById"]>
        >,
        format: string,
    ): SchemaURIMeta {
        if (format === "dc+sd-jwt") {
            const configuredVct = this.extractConfiguredVct(credentialConfig);

            if (!configuredVct) {
                throw new BadRequestException(
                    "schemaURIs metadata is required: unable to derive vct for dc+sd-jwt from credential config.",
                );
            }

            return { vct: configuredVct };
        }

        if (format === "mso_mdoc") {
            const docType =
                credentialConfig.config?.docType ??
                (credentialConfig.config as { doctype?: string } | undefined)
                    ?.doctype;

            if (!docType) {
                throw new BadRequestException(
                    "schemaURIs metadata is required: unable to derive docType for mso_mdoc from credential config.",
                );
            }

            return { doctype_value: docType };
        }

        throw new BadRequestException(
            `schemaURIs metadata is required: unsupported format '${format}'. Provide schemaURIs[].metadata explicitly.`,
        );
    }

    private parseInternalTrustListRef(
        value: string,
    ): { tenantId: string; trustListId: string } | undefined {
        const match = /\/issuers\/([^/]+)\/trust-list\/([^/?#]+)/.exec(value);
        if (!match) {
            return undefined;
        }
        return {
            tenantId: decodeURIComponent(match[1] ?? ""),
            trustListId: decodeURIComponent(match[2] ?? ""),
        };
    }

    private async resolveInternalVerificationMethod(
        tenantId: string,
        value: string,
    ): Promise<Record<string, unknown> | undefined> {
        const ref = this.parseInternalTrustListRef(value);
        if (ref?.tenantId !== tenantId) {
            return undefined;
        }

        try {
            const trustList = await this.trustListService.findOne(
                ref.tenantId,
                ref.trustListId,
            );
            if (!trustList.keyChainId) {
                return undefined;
            }

            const keyChain = await this.keyChainService.getEntity(
                ref.tenantId,
                trustList.keyChainId,
            );
            const x509Certificate = this.toBase64Der(
                keyChain.activeCertificate,
            );
            if (!x509Certificate) {
                return undefined;
            }

            return {
                type: "X509Certificate",
                x509Certificate,
            };
        } catch {
            return undefined;
        }
    }

    private toBase64Der(certificate: string): string | undefined {
        const base64 = certificate
            .replaceAll("-----BEGIN CERTIFICATE-----", "")
            .replaceAll("-----END CERTIFICATE-----", "")
            .replace(/\s/g, "");

        if (
            !base64 ||
            !/^[A-Za-z0-9+/]*={0,2}$/.test(base64) ||
            base64.length % 4 !== 0
        ) {
            return undefined;
        }

        return base64;
    }

    private toPemCertificate(base64Der: string): string {
        const lines = base64Der.match(/.{1,64}/g) ?? [];
        return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
    }

    private trustListCertificateFile(
        trustedAuthorities: Array<Record<string, unknown>>,
    ): Blob | File {
        for (const authority of trustedAuthorities) {
            const certificate =
                authority.frameworkType === "x509"
                    ? authority.value
                    : (
                          authority.verificationMethod as
                              | Record<string, unknown>
                              | undefined
                      )?.x509Certificate;

            if (typeof certificate !== "string") {
                continue;
            }

            const base64Der = this.toBase64Der(certificate);
            if (!base64Der) {
                continue;
            }

            const pem = this.toPemCertificate(base64Der);
            return typeof File === "function"
                ? new File([pem], "trust-list-certificate.pem", {
                      type: "application/x-pem-file",
                  })
                : new Blob([pem], { type: "application/x-pem-file" });
        }

        throw new BadRequestException(
            "At least one trusted authority must provide an X.509 certificate for the registrar.",
        );
    }

    private parseVerificationMethod(
        verificationMethod: string | Record<string, unknown> | undefined,
        index: number,
    ): Record<string, unknown> | undefined {
        if (verificationMethod === undefined) {
            return undefined;
        }

        if (typeof verificationMethod === "string") {
            const trimmed = verificationMethod.trim();
            if (trimmed.length === 0) {
                return undefined;
            }

            try {
                const parsed = JSON.parse(trimmed);
                if (
                    !parsed ||
                    Array.isArray(parsed) ||
                    typeof parsed !== "object"
                ) {
                    throw new Error("verificationMethod must be a JSON object");
                }

                return parsed as Record<string, unknown>;
            } catch (error) {
                throw new BadRequestException(
                    `trustedAuthorities[${index}].verificationMethod must be valid JSON object: ${
                        error instanceof Error ? error.message : "invalid JSON"
                    }`,
                );
            }
        }

        if (Array.isArray(verificationMethod)) {
            throw new BadRequestException(
                `trustedAuthorities[${index}].verificationMethod must be an object`,
            );
        }

        return verificationMethod;
    }

    private async normalizeTrustedAuthority(
        tenantId: string,
        entry: TrustedAuthorityInput,
        index: number,
    ): Promise<Record<string, unknown>> {
        if (entry.frameworkType === "x509") {
            if (!entry.value || !this.toBase64Der(entry.value)) {
                throw new BadRequestException(
                    `trustedAuthorities[${index}].value must be a base64-encoded DER X.509 certificate for x509 authorities.`,
                );
            }
            if (entry.verificationMethod) {
                throw new BadRequestException(
                    `trustedAuthorities[${index}].verificationMethod must be omitted for x509 authorities.`,
                );
            }

            return {
                frameworkType: "x509",
                value: this.toBase64Der(entry.value),
            };
        }

        if (entry.trustListId) {
            const trustList = await this.trustListService.findOne(
                tenantId,
                entry.trustListId,
            );
            if (!trustList.keyChainId) {
                throw new BadRequestException(
                    `Trust list ${entry.trustListId} has no key chain configured.`,
                );
            }

            const keyChain = await this.keyChainService.getEntity(
                tenantId,
                trustList.keyChainId,
            );
            const x509Certificate = this.toBase64Der(
                keyChain.activeCertificate,
            );
            if (!x509Certificate) {
                throw new BadRequestException(
                    `Trust list ${entry.trustListId} key chain has no active certificate.`,
                );
            }

            const publicUrl = this.configService
                .getOrThrow<string>("PUBLIC_URL")
                .replace(/\/$/, "");

            return {
                frameworkType: "etsi_tl",
                value: `${publicUrl}/issuers/${tenantId}/trust-list/${trustList.id}`,
                verificationMethod: {
                    type: "X509Certificate",
                    x509Certificate,
                },
            };
        }

        const verificationMethod =
            this.parseVerificationMethod(entry.verificationMethod, index) ??
            (entry.value
                ? await this.resolveInternalVerificationMethod(
                      tenantId,
                      entry.value,
                  )
                : undefined);

        if (!verificationMethod) {
            throw new BadRequestException(
                `trustedAuthorities[${index}] requires verificationMethod for external authorities.`,
            );
        }

        return {
            ...(entry.frameworkType
                ? { frameworkType: entry.frameworkType }
                : {}),
            ...(entry.value ? { value: entry.value } : {}),
            verificationMethod,
        };
    }

    private async resolveTrustedAuthoritiesForRegistrar(
        tenantId: string,
        authorities: SignSchemaMetaConfigDto["config"]["trustedAuthorities"],
    ): Promise<Array<Record<string, unknown>>> {
        return Promise.all(
            (authorities ?? []).map((entry, index) =>
                this.normalizeTrustedAuthority(tenantId, entry, index),
            ),
        );
    }

    private async fetchRemoteFile(
        sourceUrl: string,
        fallbackFileName: string,
        label: string,
    ): Promise<Blob | File> {
        // Tenant-supplied URL: fetched under the shared outbound URL policy
        // (no private targets, every redirect hop checked, bounded size/time).
        let response: OutboundFinalResponse;
        try {
            response = await this.outboundUrlPolicy.getFollowingRedirects(
                sourceUrl,
                {
                    timeoutMs: REMOTE_FILE_TIMEOUT_MS,
                    maxBytes: REMOTE_FILE_MAX_BYTES,
                    maxRedirects: REMOTE_FILE_MAX_REDIRECTS,
                },
            );
        } catch (error) {
            throw new BadRequestException(
                `Failed to fetch ${label} (${sourceUrl}): ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }

        if (response.status < 200 || response.status >= 300) {
            throw new BadRequestException(
                `Failed to fetch ${label} (${sourceUrl}): HTTP ${response.status}`,
            );
        }

        const contentType = response.contentType || "application/octet-stream";
        const bytes = new Uint8Array(response.bytes);

        const parsedName = (() => {
            try {
                const pathname = new URL(sourceUrl).pathname;
                const segments = pathname.split("/");
                const last = segments.findLast((segment) => segment.length > 0);
                return last || fallbackFileName;
            } catch {
                return fallbackFileName;
            }
        })();

        return typeof File === "function"
            ? new File([bytes], parsedName, { type: contentType })
            : (new Blob([bytes], {
                  type: contentType,
              }) as Blob | File);
    }

    private async buildSchemaFileFromCredentialConfig(
        tenantId: string,
        credentialConfigId: string,
        fallbackFormat?: string,
    ): Promise<{
        format: string;
        meta: SchemaURIMeta;
        file: Blob | File;
    }> {
        const existing = await this.credentialsService.getById(
            tenantId,
            credentialConfigId,
        );
        const format = existing.config?.format ?? fallbackFormat ?? "dc+sd-jwt";

        const schema = buildJsonSchema(existing.fields as any);
        if (!schema || Object.keys(schema.properties ?? {}).length === 0) {
            throw new BadRequestException(
                `Credential config ${credentialConfigId} has no inline schema to upload. Provide schemaURIs explicitly or set the credential schema first.`,
            );
        }

        const fileName = `schema-${credentialConfigId}-${format}.json`;
        const schemaContent = JSON.stringify(schema, null, 2);
        const schemaFile =
            typeof File === "function"
                ? new File([schemaContent], fileName, {
                      type: "application/schema+json",
                  })
                : new Blob([schemaContent], {
                      type: "application/schema+json",
                  });

        return {
            format,
            meta: this.deriveSchemaUriMetadata(existing, format),
            file: schemaFile,
        };
    }

    private async resolveSchemaEntries(
        tenantId: string,
        config: SignSchemaMetaConfigDto["config"],
        credentialConfigId?: string,
    ): Promise<
        Array<{
            format: string;
            meta: SchemaURIMeta;
            file: Blob | File;
        }>
    > {
        let requestedEntries = config.schemaURIs ?? [];
        if (requestedEntries.length === 0 && credentialConfigId) {
            requestedEntries = [{ credentialConfigId }];
        }

        if (requestedEntries.length === 0) {
            throw new BadRequestException(
                "At least one schemaURIs entry is required. Provide schemaURIs or credentialConfigId.",
            );
        }

        return Promise.all(
            requestedEntries.map(async (entry, index) => {
                if (entry.credentialConfigId) {
                    return this.buildSchemaFileFromCredentialConfig(
                        tenantId,
                        entry.credentialConfigId,
                        entry.format,
                    );
                }

                if (!entry.uri) {
                    throw new BadRequestException(
                        `schemaURIs[${index}] requires either credentialConfigId or uri`,
                    );
                }

                if (!entry.format) {
                    throw new BadRequestException(
                        `schemaURIs[${index}].format is required for manual schema URI entries`,
                    );
                }

                if (!entry.meta) {
                    throw new BadRequestException(
                        `schemaURIs[${index}].meta is required for manual schema URI entries`,
                    );
                }

                const file = await this.fetchRemoteFile(
                    entry.uri,
                    `schema-${entry.format}.json`,
                    "schema",
                );

                return {
                    format: entry.format,
                    meta: entry.meta,
                    file,
                };
            }),
        );
    }

    private normalizeConfigFromFormInput(
        config: SignSchemaMetaConfigDto["config"],
    ): SignSchemaMetaConfigDto["config"] {
        const normalizedSchemaUris = (config.schemaURIs ?? []).map((entry) => ({
            ...(entry.credentialConfigId
                ? { credentialConfigId: entry.credentialConfigId }
                : {}),
            ...(entry.format ? { format: entry.format } : {}),
            ...(entry.uri ? { uri: entry.uri } : {}),
            ...(entry.meta ? { meta: entry.meta } : {}),
        }));

        const normalizedTrustedAuthorities = (
            config.trustedAuthorities ?? []
        ).map((entry) => ({
            ...(entry.trustListId ? { trustListId: entry.trustListId } : {}),
            ...(entry.frameworkType
                ? { frameworkType: entry.frameworkType }
                : {}),
            ...(entry.value ? { value: entry.value } : {}),
            ...(entry.verificationMethod
                ? { verificationMethod: entry.verificationMethod }
                : {}),
        }));

        return {
            ...config,
            schemaURIs: normalizedSchemaUris,
            trustedAuthorities: normalizedTrustedAuthorities,
        };
    }

    private buildRegistrarMetadata(
        config: SignSchemaMetaConfigDto["config"],
        schemaEntries: Array<{ format: string; meta: SchemaURIMeta }>,
        trustedAuthorities: Array<Record<string, unknown>>,
    ): RegistrarMetadataPayload {
        const metadata: RegistrarMetadataPayload = {
            ...(config.id ? { id: config.id } : {}),
            version: config.version,
            attestationLoS: config.attestationLoS,
            bindingType: config.bindingType,
            trustedAuthorities:
                trustedAuthorities as RegistrarMetadataPayload["trustedAuthorities"],
            schemas: [],
        };

        metadata.schemas = schemaEntries.map((entry, fileIndex) => {
            let schemaTypeIdentifier: string | undefined;

            if (entry.format === "dc+sd-jwt") {
                const vct = (entry.meta as { vct?: unknown })?.vct;
                if (typeof vct === "string" && vct.length > 0) {
                    schemaTypeIdentifier = vct;
                }
            } else if (entry.format === "mso_mdoc") {
                const docType =
                    (entry.meta as { doctype_value?: unknown })
                        ?.doctype_value ??
                    (entry.meta as { doctype?: unknown })?.doctype;
                if (typeof docType === "string" && docType.length > 0) {
                    schemaTypeIdentifier = docType;
                }
            }

            if (!schemaTypeIdentifier) {
                throw new BadRequestException(
                    `Unable to derive schemaTypeIdentifier for format '${entry.format}'.`,
                );
            }

            return {
                formatIdentifier: entry.format,
                fileIndex,
                schemaTypeIdentifier,
            };
        }) as RegistrarMetadataPayload["schemas"];

        return metadata;
    }

    private buildPostCreateMetadataUpdate(
        config: SignSchemaMetaConfigDto["config"],
    ): UpdateSchemaMetadataDto | undefined {
        const displayName =
            typeof config.name === "string" && config.name.trim().length > 0
                ? config.name.trim()
                : undefined;

        const category = (config as { category?: unknown }).category;
        const normalizedCategory =
            typeof category === "string" ? category : undefined;

        const tags = (config as { tags?: unknown }).tags;
        const normalizedTags =
            Array.isArray(tags) && tags.every((tag) => typeof tag === "string")
                ? tags
                : undefined;

        if (!displayName && !normalizedCategory && !normalizedTags?.length) {
            return undefined;
        }

        return {
            ...(displayName ? { displayName } : {}),
            ...(normalizedCategory
                ? {
                      category:
                          normalizedCategory as UpdateSchemaMetadataDto["category"],
                  }
                : {}),
            ...(normalizedTags?.length
                ? { tags: normalizedTags as UpdateSchemaMetadataDto["tags"] }
                : {}),
        };
    }

    private async updateCredentialConfigSchemaMetaLink(
        tenantId: string,
        credentialConfigId: string,
        normalizedConfig: SignSchemaMetaConfigDto["config"],
        generatedSchemaMetadataId: string,
        pinMode: SchemaMetadataPinMode = SchemaMetadataPinMode.KEEP_CURRENT,
    ): Promise<void> {
        const existing = await this.credentialsService.getById(
            tenantId,
            credentialConfigId,
        );

        const existingPinnedId =
            typeof existing.schemaMeta?.id === "string"
                ? existing.schemaMeta.id
                : undefined;

        if (
            existingPinnedId &&
            existingPinnedId !== generatedSchemaMetadataId &&
            pinMode !== SchemaMetadataPinMode.REPLACE_ID
        ) {
            throw new BadRequestException(
                `Credential config '${credentialConfigId}' is already pinned to schema metadata id '${existingPinnedId}'. Use pinMode='replace_id' to repoint it to '${generatedSchemaMetadataId}'.`,
            );
        }

        const hasNoPinnedId = !existingPinnedId;
        const isSamePinnedId = existingPinnedId === generatedSchemaMetadataId;

        const shouldUpdatePin =
            hasNoPinnedId ||
            pinMode === SchemaMetadataPinMode.REPLACE_ID ||
            (pinMode === SchemaMetadataPinMode.UPDATE_TO_NEW_VERSION &&
                isSamePinnedId);

        if (!shouldUpdatePin) {
            return;
        }

        const schemaMetaForLink = {
            ...existing.schemaMeta,
            ...normalizedConfig,
            id: generatedSchemaMetadataId,
        };

        await this.credentialsService.update(tenantId, credentialConfigId, {
            schemaMeta: schemaMetaForLink as any,
        });
    }

    async submitSchemaMetadata(
        tenantId: string,
        body: SignSchemaMetaConfigDto,
    ) {
        const normalizedConfig = this.normalizeConfigFromFormInput(body.config);

        const isLinkOnlyRequest =
            !!body.credentialConfigId &&
            typeof normalizedConfig.id === "string" &&
            normalizedConfig.id.trim().length > 0 &&
            (!normalizedConfig.rulebookURI ||
                normalizedConfig.rulebookURI.trim().length === 0);

        if (isLinkOnlyRequest) {
            await this.updateCredentialConfigSchemaMetaLink(
                tenantId,
                body.credentialConfigId!,
                normalizedConfig,
                normalizedConfig.id!,
                body.pinMode,
            );

            return this.schemaMetadataService.findOne(
                tenantId,
                normalizedConfig.id!,
            );
        }

        if (
            !normalizedConfig.name ||
            normalizedConfig.name.trim().length === 0
        ) {
            throw new BadRequestException(
                "config.name is required when publishing new schema metadata",
            );
        }

        if (
            !normalizedConfig.rulebookURI ||
            normalizedConfig.rulebookURI.trim().length === 0
        ) {
            throw new BadRequestException(
                "config.rulebookURI is required when publishing new schema metadata",
            );
        }

        const [rulebookFile, schemaEntries, trustedAuthorities] =
            await Promise.all([
                this.fetchRemoteFile(
                    normalizedConfig.rulebookURI,
                    `rulebook-${normalizedConfig.version}.md`,
                    "rulebook",
                ),
                this.resolveSchemaEntries(
                    tenantId,
                    normalizedConfig,
                    body.credentialConfigId,
                ),
                this.resolveTrustedAuthoritiesForRegistrar(
                    tenantId,
                    normalizedConfig.trustedAuthorities,
                ),
            ]);

        const result = await this.schemaMetadataService.createSchemaMetadata(
            tenantId,
            {
                metadata: this.buildRegistrarMetadata(
                    normalizedConfig,
                    schemaEntries,
                    trustedAuthorities,
                ),
                rulebookFile,
                trustListCertificateFile:
                    this.trustListCertificateFile(trustedAuthorities),
                schemaFiles: schemaEntries.map((entry) => entry.file),
            },
        );

        const metadataUpdate =
            this.buildPostCreateMetadataUpdate(normalizedConfig);
        const finalResult = metadataUpdate
            ? await this.schemaMetadataService.updateMetadata(
                  tenantId,
                  result.id,
                  result.version,
                  metadataUpdate,
              )
            : result;

        if (body.credentialConfigId) {
            await this.updateCredentialConfigSchemaMetaLink(
                tenantId,
                body.credentialConfigId,
                normalizedConfig,
                finalResult.id,
                body.pinMode,
            );
        }

        return finalResult;
    }

    async submitSchemaMetadataVersion(
        tenantId: string,
        body: SignVersionSchemaMetaConfigDto,
    ) {
        const normalizedConfig = this.normalizeConfigFromFormInput(body.config);

        if (!normalizedConfig.id) {
            throw new BadRequestException(
                "config.id is required when publishing a new version of an existing schema metadata entry",
            );
        }

        if (
            !normalizedConfig.name ||
            normalizedConfig.name.trim().length === 0
        ) {
            throw new BadRequestException(
                "config.name is required when publishing a new schema metadata version",
            );
        }

        if (
            !normalizedConfig.rulebookURI ||
            normalizedConfig.rulebookURI.trim().length === 0
        ) {
            throw new BadRequestException(
                "config.rulebookURI is required when publishing a new schema metadata version",
            );
        }

        const [rulebookFile, schemaEntries, trustedAuthorities] =
            await Promise.all([
                this.fetchRemoteFile(
                    normalizedConfig.rulebookURI,
                    `rulebook-${normalizedConfig.version}.md`,
                    "rulebook",
                ),
                this.resolveSchemaEntries(
                    tenantId,
                    normalizedConfig,
                    body.credentialConfigId,
                ),
                this.resolveTrustedAuthoritiesForRegistrar(
                    tenantId,
                    normalizedConfig.trustedAuthorities,
                ),
            ]);

        const result = await this.schemaMetadataService.createSchemaMetadata(
            tenantId,
            {
                metadata: this.buildRegistrarMetadata(
                    normalizedConfig,
                    schemaEntries,
                    trustedAuthorities,
                ),
                rulebookFile,
                trustListCertificateFile:
                    this.trustListCertificateFile(trustedAuthorities),
                schemaFiles: schemaEntries.map((entry) => entry.file),
            },
        );

        const metadataUpdate =
            this.buildPostCreateMetadataUpdate(normalizedConfig);
        const finalResult = metadataUpdate
            ? await this.schemaMetadataService.updateMetadata(
                  tenantId,
                  result.id,
                  result.version,
                  metadataUpdate,
              )
            : result;

        if (body.credentialConfigId) {
            await this.updateCredentialConfigSchemaMetaLink(
                tenantId,
                body.credentialConfigId,
                normalizedConfig,
                finalResult.id,
                body.pinMode,
            );
        }

        return finalResult;
    }
}
