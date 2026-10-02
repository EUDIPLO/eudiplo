import { X509Certificate } from "node:crypto";
import {
    BadRequestException,
    ConflictException,
    Injectable,
    Logger,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import {
    createLoTE,
    type LoTE,
    type LoTEDocument,
    type TrustedEntity as LoTETrustedEntity,
    service,
    signLoTE,
    trustedEntity,
} from "@owf/eudi-lote";
import { Repository } from "typeorm";
import { v4 } from "uuid";
import { TenantEntity } from "../../auth/tenant/entities/tenant.entity.js";
import {
    CertificateInfo,
    CertService,
} from "../../crypto/key/cert/cert.service.js";
import { KeyChainService } from "../../crypto/key/key-chain.service.js";
import { KeyUsageType } from "../../crypto/key/types/key-usage-type.js";
import { ConfigImportService } from "../../platform/config-import/config-import.service.js";
import {
    ConfigImportOrchestratorService,
    ImportPhase,
} from "../../platform/config-import/config-import-orchestrator.service.js";
import { loadConfigDto } from "../../shared/utils/config-file-loader.util.js";
import {
    isTrustListRenewalDue,
    trustListNextUpdate,
} from "./domain/trust-list-validity.js";
import {
    TrustListCreateDto,
    TrustListEntity,
    TrustListEntityInfo,
} from "./dto/trust-list-create.dto.js";
import { TrustList } from "./entities/trust-list.entity.js";
import { TrustListVersion } from "./entities/trust-list-version.entity.js";
import { TrustListCreateSchema } from "./schemas/trust-list.schema.js";

enum ServiceTypeIdentifier {
    WalletIssuance = "http://uri.etsi.org/19602/SvcType/WalletSolution/Issuance",
    WalletRevocation = "http://uri.etsi.org/19602/SvcType/WalletSolution/Revocation",
    PIDIssuance = "http://uri.etsi.org/19602/SvcType/PID/Issuance",
    EaaIssuance = "http://uri.etsi.org/19602/SvcType/EAA/Issuance",
    EaaRevocation = "http://uri.etsi.org/19602/SvcType/EAA/Revocation",
}

/** Default language for trust list entries */
const DEFAULT_LANG = "en";

/** Fields that change when a new version of a trust list is published. */
type TrustListVersionChanges = Pick<
    TrustList,
    "sequenceNumber" | "data" | "jwt"
> &
    Partial<Pick<TrustList, "description" | "keyChainId" | "entityConfig">>;

/** Stored list content; lists created by older releases lack the `LoTE` wrapper. */
function storedLoTE(data: object | undefined): LoTE | undefined {
    const content = (data as { LoTE?: LoTE } | undefined)?.LoTE ?? data;
    return (content as LoTE | undefined)?.ListAndSchemeInformation
        ? (content as LoTE)
        : undefined;
}

@Injectable()
export class TrustListService {
    private readonly logger = new Logger(TrustListService.name);

    constructor(
        @InjectRepository(TrustList)
        private readonly trustListRepo: Repository<TrustList>,
        @InjectRepository(TrustListVersion)
        private readonly trustListVersionRepo: Repository<TrustListVersion>,
        public readonly keyChainService: KeyChainService,
        private readonly certService: CertService,
        private readonly configImportService: ConfigImportService,
        @InjectRepository(TenantEntity)
        private readonly tenantRepository: Repository<TenantEntity>,
        configImportOrchestrator: ConfigImportOrchestratorService,
    ) {
        configImportOrchestrator.register(
            "status-lists",
            ImportPhase.FINAL,
            (tenantId) => this.importForTenant(tenantId),
        );
    }

    /**
     * Create a new trust list
     * @param values
     * @param tenant
     * @returns
     */
    create(
        values: TrustListCreateDto,
        tenant: Pick<TenantEntity, "id" | "name">,
    ): Promise<TrustList> {
        return this.buildAndSaveTrustList(values, tenant);
    }

    /**
     * Finds all trust lists for the tenant
     * @param tenant
     * @returns
     */
    findAll(tenant: Pick<TenantEntity, "id" | "name">): Promise<TrustList[]> {
        return this.trustListRepo.findBy({ tenantId: tenant.id });
    }

    /**
     * Find one trust list by tenantId and id
     * @param tenantId
     * @param id
     * @returns
     */
    findOne(tenantId: string, id: string): Promise<TrustList> {
        return this.trustListRepo.findOneByOrFail({ tenantId, id });
    }

    async exportTrustList(
        tenantId: string,
        id: string,
    ): Promise<TrustListCreateDto> {
        const entry = await this.findOne(tenantId, id);
        return {
            id: entry.id,
            description: entry.description,
            keyChainId: entry.keyChainId,
            entities: entry.entityConfig ?? [],
            data: entry.data,
        };
    }

    /**
     * Update a trust list with new entities
     * Increments the sequence number and stores the previous version for audit
     * @param tenantId
     * @param id
     * @param values
     * @returns
     */
    async update(
        tenantId: string,
        id: string,
        values: TrustListCreateDto,
    ): Promise<TrustList> {
        const existing = await this.findOne(tenantId, id);
        const tenant = await this.tenantRepository.findOneByOrFail({
            id: tenantId,
        });

        return this.buildAndSaveTrustList(values, tenant, existing);
    }

    /**
     * Re-issue every managed trust list, across all tenants, whose `NextUpdate`
     * is within the renewal window or already passed. Each list keeps its
     * entities and gets the next sequence number, a fresh `NextUpdate` and a
     * new signature; the previous version is kept in the version history.
     *
     * Safe to run on several replicas at once: a list is only replaced while
     * its sequence number is unchanged, so exactly one renewal wins.
     * @returns the number of lists this call renewed
     */
    async renewDueTrustLists(now = new Date()): Promise<number> {
        let renewed = 0;
        for (const trustList of await this.trustListRepo.find()) {
            const lote = storedLoTE(trustList.data);
            if (
                !lote ||
                !isTrustListRenewalDue(
                    lote.ListAndSchemeInformation.NextUpdate,
                    now,
                )
            ) {
                continue;
            }
            try {
                if (await this.renew(trustList, lote, now)) renewed++;
            } catch (error) {
                this.logger.error(
                    `Failed to renew trust list ${trustList.id} of tenant ${trustList.tenantId}: ${error}`,
                );
            }
        }
        return renewed;
    }

    /**
     * Get version history for a trust list
     * @param tenantId
     * @param trustListId
     * @returns
     */
    getVersionHistory(
        tenantId: string,
        trustListId: string,
    ): Promise<TrustListVersion[]> {
        return this.trustListVersionRepo.find({
            where: { tenantId, trustListId },
            order: { sequenceNumber: "DESC" },
        });
    }

    /**
     * Get a specific version of a trust list
     * @param tenantId
     * @param trustListId
     * @param versionId
     * @returns
     */
    getVersion(
        tenantId: string,
        trustListId: string,
        versionId: string,
    ): Promise<TrustListVersion> {
        return this.trustListVersionRepo.findOneByOrFail({
            tenantId,
            trustListId,
            id: versionId,
        });
    }

    /**
     * Remove a trust list
     * @param tenantId
     * @param id
     */
    async remove(tenantId: string, id: string): Promise<void> {
        await this.trustListRepo.delete({ tenantId, id });
    }

    /**
     * Imports trust lists for a specific tenant from the file system.
     */
    async importForTenant(tenantId: string) {
        await this.configImportService.importConfigsForTenant<TrustListCreateDto>(
            tenantId,
            {
                subfolder: "trust-lists",
                fileExtension: ".json",
                validationSchema: TrustListCreateSchema,
                resourceType: "trustlist",
                loadData: (filePath) =>
                    loadConfigDto(filePath, TrustListCreateSchema),
                checkExists: (tenantId, data) => {
                    return this.findOne(tenantId, data.id!)
                        .then(() => true)
                        .catch(() => false);
                },
                deleteExisting: async (tenantId, data) => {
                    await this.trustListRepo.delete({
                        id: data.id,
                        tenantId,
                    });
                },
                processItem: async (tenantId, config) => {
                    const tenant = await this.tenantRepository.findOneByOrFail({
                        id: tenantId,
                    });
                    await this.buildAndSaveTrustList(config, tenant);
                },
            },
        );
    }
    /**
     * Shared logic for creating and saving a trust list (used by both API and import)
     * @param config The configuration for the trust list
     * @param tenant The tenant entity
     * @param existing Optional existing trust list to update
     */
    private async buildAndSaveTrustList(
        config: TrustListCreateDto,
        tenant: Pick<TenantEntity, "id" | "name">,
        existing?: TrustList,
    ): Promise<TrustList> {
        // Validate PEM certificates for external entities
        for (const entity of config.entities || []) {
            if (entity.type === "external") {
                this.validatePem(entity.issuerCertPem, "issuerCertPem");
                this.validatePem(entity.revocationCertPem, "revocationCertPem");
            }
        }

        let cert: CertificateInfo;
        if (config.keyChainId) {
            cert = await this.certService.getCertificateById(
                tenant.id,
                config.keyChainId,
            );
            // Check if the key has the TrustList usage
            if (cert.keyChain?.usageType !== KeyUsageType.TrustList) {
                throw new BadRequestException(
                    `Key chain ${config.keyChainId} is not valid for Trust List usage (key lacks TrustList usage)`,
                );
            }
        } else if (existing?.keyChainId) {
            cert = await this.certService.getCertificateById(
                tenant.id,
                existing.keyChainId,
            );
        } else {
            cert = await this.certService.findOrCreate({
                tenantId: tenant.id,
                type: KeyUsageType.TrustList,
            });
        }

        // Keep the stored state: it becomes the previous version on updates
        const previous = existing ? { ...existing } : undefined;

        // Use existing trust list or create new
        const trustList =
            existing ??
            this.trustListRepo.create({
                tenant,
                tenantId: tenant.id,
                id: config.id ?? v4(),
            });

        // Update properties
        trustList.description = config.description;
        trustList.keyChainId = cert.id;
        trustList.entityConfig = config.entities;

        // Increment sequence number on updates
        if (existing) {
            trustList.sequenceNumber = (existing.sequenceNumber || 1) + 1;
        } else {
            trustList.sequenceNumber = 1;
        }

        const entries: LoTETrustedEntity[] = [];
        for (const entity of config.entities || []) {
            if (entity.type === "internal") {
                // Internal: fetch certificates from database by ID
                const issuerCert = await this.certService.getCertificateById(
                    tenant.id,
                    entity.issuerKeyChainId,
                );
                const revocationCert =
                    await this.certService.getCertificateById(
                        tenant.id,
                        entity.revocationKeyChainId,
                    );
                try {
                    const leaf = new X509Certificate(issuerCert.crt[0]);
                    // X509Certificate.fingerprint returns SHA-1 by default; compute SHA-256 for parity with verifier logs.
                    const der = leaf.raw;
                    const _thumb = Array.from(
                        new Uint8Array(
                            await crypto.subtle.digest("SHA-256", der),
                        ),
                    )
                        .map((b) => b.toString(16).padStart(2, "0"))
                        .join(":")
                        .toUpperCase();
                } catch {
                    // ignore diagnostic failures
                }
                entries.push(
                    this.createEntityFromCert(
                        issuerCert,
                        revocationCert,
                        entity.info,
                        entity.providerType,
                    ),
                );
            } else {
                // External: use PEM certificates directly with provided info
                entries.push(
                    this.createEntityFromPem(
                        entity.issuerCertPem,
                        entity.revocationCertPem,
                        entity.info,
                        entity.providerType,
                    ),
                );
            }
        }

        trustList.data = this.createList(
            tenant,
            entries,
            trustList.sequenceNumber,
            config.entities.every(
                (entity) => entity.providerType === "wallet-provider",
            ),
        );
        trustList.jwt = await this.generateJwt(trustList);
        if (!previous) {
            return this.trustListRepo.save(trustList);
        }

        const published = await this.publishNextVersion(previous, {
            description: trustList.description,
            keyChainId: trustList.keyChainId,
            entityConfig: trustList.entityConfig,
            sequenceNumber: trustList.sequenceNumber,
            data: trustList.data,
            jwt: trustList.jwt,
        });
        if (!published) {
            throw new ConflictException(
                `Trust list ${previous.id} was modified concurrently; retry the update`,
            );
        }
        return this.findOne(previous.tenantId, previous.id);
    }

    /**
     * Re-issue a trust list with unchanged entities, the next sequence number
     * and a fresh validity period.
     * @returns false when another writer published a new version first
     */
    private async renew(
        trustList: TrustList,
        lote: LoTE,
        now: Date,
    ): Promise<boolean> {
        const sequenceNumber = (trustList.sequenceNumber || 1) + 1;
        const data: LoTEDocument = {
            LoTE: {
                ...lote,
                ListAndSchemeInformation: {
                    ...lote.ListAndSchemeInformation,
                    LoTESequenceNumber: sequenceNumber,
                    ListIssueDateTime: now.toISOString(),
                    NextUpdate: trustListNextUpdate(now).toISOString(),
                },
            },
        };
        const jwt = await this.generateJwt({ ...trustList, data });

        const published = await this.publishNextVersion(trustList, {
            sequenceNumber,
            data,
            jwt,
        });
        if (published) {
            this.logger.log(
                `Renewed trust list ${trustList.id} of tenant ${trustList.tenantId} (sequence number ${sequenceNumber}, next update ${data.LoTE.ListAndSchemeInformation.NextUpdate})`,
            );
        } else {
            this.logger.debug(
                `Trust list ${trustList.id} of tenant ${trustList.tenantId} was already re-issued by another writer`,
            );
        }
        return published;
    }

    /**
     * Replace a trust list with its next version and keep the previous one in
     * the version history, atomically. The write only applies while the stored
     * sequence number still equals `previous.sequenceNumber` (compare-and-set),
     * so concurrent writers such as renewals on other replicas or API updates
     * never publish two lists with the same sequence number.
     * @returns false when the list changed since `previous` was read
     */
    private publishNextVersion(
        previous: TrustList,
        changes: TrustListVersionChanges,
    ): Promise<boolean> {
        return this.trustListRepo.manager.transaction(async (manager) => {
            const result = await manager.update(
                TrustList,
                {
                    tenantId: previous.tenantId,
                    id: previous.id,
                    sequenceNumber: previous.sequenceNumber,
                },
                changes,
            );
            if (result.affected !== 1) {
                return false;
            }
            await manager.insert(TrustListVersion, {
                trustListId: previous.id,
                tenantId: previous.tenantId,
                sequenceNumber: previous.sequenceNumber || 1,
                data: previous.data ?? {},
                entityConfig: previous.entityConfig,
                jwt: previous.jwt,
            });
            return true;
        });
    }

    /**
     * Validate that a string is a valid PEM certificate
     * @param pem The PEM string to validate
     * @param fieldName The field name for error messages
     */
    private validatePem(pem: string, fieldName: string): void {
        if (!pem || pem.trim() === "") {
            throw new BadRequestException(`${fieldName} is required`);
        }
        try {
            new X509Certificate(pem);
        } catch {
            throw new BadRequestException(
                `${fieldName} is not a valid X.509 certificate`,
            );
        }
    }

    /**
     * Get the JWT of the trust list
     * @param tenantId
     * @param id
     * @returns
     */
    getJwt(tenantId: string, id: string): Promise<string> {
        return this.findOne(tenantId, id).then(
            (trustList) => trustList.jwt,
            (err) => {
                throw new BadRequestException(err.message);
            },
        );
    }

    /**
     * Resolve verifier certificate material for a managed trust list.
     * Returns base64 DER (without PEM headers) suitable for `verifierX509Der`.
     */
    async getVerifierX509Der(tenantId: string, id: string): Promise<string> {
        const trustList = await this.findOne(tenantId, id);
        const cert = await this.certService.getCertificateById(
            tenantId,
            trustList.keyChainId,
        );
        // Pin the certificate whose key signs the JWT, rather than its root CA.
        return this.formatPem(cert.crt[0]);
    }

    /**
     * Generate a signed JWT for the trust list using @owf/eudi-lote
     * @param trustList The trust list to sign
     * @returns Signed JWT string
     */
    async generateJwt(trustList: TrustList): Promise<string> {
        const cert = await this.certService.getCertificateById(
            trustList.tenantId,
            trustList.keyChainId,
        );

        // Get the signer from key chain service
        const signer = await this.keyChainService.signer(
            trustList.tenantId,
            cert.keyId,
        );

        // Sign using @owf/eudi-lote
        const signed = await signLoTE({
            lote: trustList.data as LoTEDocument,
            keyId: cert.keyId,
            signer,
            certificates: cert.crt,
        });

        return signed.jws;
    }

    /**
     * Create a LoTE trusted entity from internal certificate references
     */
    private createEntityFromCert(
        issuerCert: CertificateInfo,
        revocationCert: CertificateInfo,
        info: TrustListEntityInfo,
        providerType?: TrustListEntity["providerType"],
    ): LoTETrustedEntity {
        return this.createEntityFromData(
            this.formatCertEntity(issuerCert),
            this.formatCertEntity(revocationCert),
            info,
            providerType,
        );
    }

    /**
     * Create a LoTE trusted entity from PEM certificates
     */
    private createEntityFromPem(
        issuerCertPem: string,
        revocationCertPem: string,
        info: TrustListEntityInfo,
        providerType?: TrustListEntity["providerType"],
    ): LoTETrustedEntity {
        return this.createEntityFromData(
            this.formatPem(issuerCertPem),
            this.formatPem(revocationCertPem),
            info,
            providerType,
        );
    }

    /**
     * Create a LoTE trusted entity using the @owf/eudi-lote builders
     */
    private createEntityFromData(
        issuerCertBase64: string,
        revocationCertBase64: string,
        info: TrustListEntityInfo,
        providerType?: TrustListEntity["providerType"],
    ): LoTETrustedEntity {
        const lang = info.lang || DEFAULT_LANG;
        const walletProvider = providerType === "wallet-provider";

        // Build the issuance service
        const issuanceService = service()
            .name(
                walletProvider
                    ? "Wallet-Issuance-Service"
                    : "EAA-Issuance-Service",
                lang,
            )
            .type(
                walletProvider
                    ? ServiceTypeIdentifier.WalletIssuance
                    : ServiceTypeIdentifier.EaaIssuance,
            )
            .addCertificate(issuerCertBase64)
            .build();

        // Build the revocation service
        const revocationService = service()
            .name(
                walletProvider
                    ? "Wallet-Revocation-Service"
                    : "EAA-Revocation-Service",
                lang,
            )
            .type(
                walletProvider
                    ? ServiceTypeIdentifier.WalletRevocation
                    : ServiceTypeIdentifier.EaaRevocation,
            )
            .addCertificate(revocationCertBase64)
            .build();

        // Build the trusted entity - only add optional fields if they have values
        const entityBuilder = trustedEntity()
            .name(info.name, lang)
            .addService(issuanceService)
            .addService(revocationService);

        // Only add infoUri if a valid URI is provided
        if (info.uri) {
            entityBuilder.infoUri(info.uri, lang);
        }

        // Postal address is required by @owf/eudi-lote - use "EU" as default country
        entityBuilder.postalAddress(
            {
                Country: info.country || "EU",
                Locality: info.locality || "",
                PostalCode: info.postalCode || "",
                StreetAddress: info.streetAddress || "",
            },
            lang.split("-")[0], // Use short lang code for postal
        );

        // Only add email if a valid URI is provided
        if (info.contactUri) {
            entityBuilder.email(info.contactUri, lang);
        }

        return entityBuilder.build();
    }

    /**
     * Create a LoTE document using @owf/eudi-lote
     */
    createList(
        tenant: Pick<TenantEntity, "id" | "name">,
        entities: LoTETrustedEntity[],
        sequenceNumber = 1,
        walletProviders = false,
    ): LoTEDocument {
        const issuedAt = new Date();
        const nextUpdate = trustListNextUpdate(issuedAt);

        return createLoTE(
            {
                SchemeOperatorName: [
                    {
                        lang: DEFAULT_LANG,
                        value: tenant.name,
                    },
                ],
                LoTEType: walletProviders
                    ? "http://uri.etsi.org/19602/LoTEType/EUWalletProvidersList"
                    : "http://uri.etsi.org/19602/LoTEType/EUEAAProvidersList",
                StatusDeterminationApproach: walletProviders
                    ? "http://uri.etsi.org/19602/WalletProvidersList/StatusDetn/EU"
                    : "http://uri.etsi.org/19602/EUEAAProvidersList/StatusDetn/EU",
                SchemeTypeCommunityRules: [
                    {
                        lang: DEFAULT_LANG,
                        uriValue: walletProviders
                            ? "http://uri.etsi.org/19602/WalletProvidersList/schemerules/EU"
                            : "http://uri.etsi.org/19602/EUEAAProviders/schemerules/EU",
                    },
                ],
                SchemeTerritory: "EU",
                ListIssueDateTime: issuedAt.toISOString(),
                NextUpdate: nextUpdate.toISOString(),
                LoTESequenceNumber: sequenceNumber,
            },
            entities,
        );
    }

    /**
     * Format CertificateInfo to base64 DER without PEM headers.
     * Uses the last certificate in the chain as the trust anchor (root CA for InternalChain
     * key chains, or the single cert for standalone key chains). This ensures trust list
     * entries survive leaf cert rotation, since the root CA cert is fixed.
     * @param cert
     * @returns
     */
    formatCertEntity(cert: CertificateInfo): string {
        const anchorPem = cert.crt.at(-1) ?? cert.crt[0];
        return this.formatPem(anchorPem);
    }

    /**
     * Format PEM string to base64 DER without PEM headers
     * @param pem
     * @returns
     */
    formatPem(pem: string): string {
        return pem
            .replaceAll("-----BEGIN CERTIFICATE-----", "")
            .replaceAll("-----END CERTIFICATE-----", "")
            .replaceAll(/\r?\n|\r/g, "");
    }
}
