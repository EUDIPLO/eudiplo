import {
    trustListMailtoUri,
    trustListTelUri,
} from "@eudiplo/config-format/trust-list-entity-info.js";
import {
    BadRequestException,
    ConflictException,
    Injectable,
    Logger,
    NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import {
    createLoTE,
    type LoTE,
    type LoTEDocument,
    LoTEException,
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
import { TrustListReferences } from "./application/trust-list-references.js";
import {
    entityKeyChainReferences,
    entityKeyChainUsageRefusal,
    storedEntityKeyChains,
} from "./domain/trust-list-entity-key-chains.js";
import {
    type ExternalEntityCertificates,
    externalEntityCertificates,
    keyChainNotFoundIssue,
    TrustListInputError,
    type TrustListInputIssue,
} from "./domain/trust-list-input.js";
import { TrustListInUseError } from "./domain/trust-list-reference.js";
import {
    trustListKeyChainUsageRefusal,
    trustListSigningKeyChain,
} from "./domain/trust-list-signing-key-chain.js";
import {
    isTrustListRenewalDue,
    trustListDateTime,
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
import { trustListConfig } from "./trust-list-config.js";

enum ServiceTypeIdentifier {
    WalletIssuance = "http://uri.etsi.org/19602/SvcType/WalletSolution/Issuance", // NOSONAR: ETSI identifier URI, not fetched
    WalletRevocation = "http://uri.etsi.org/19602/SvcType/WalletSolution/Revocation", // NOSONAR: ETSI identifier URI, not fetched
    PIDIssuance = "http://uri.etsi.org/19602/SvcType/PID/Issuance", // NOSONAR: ETSI identifier URI, not fetched
    EaaIssuance = "http://uri.etsi.org/19602/SvcType/EAA/Issuance", // NOSONAR: ETSI identifier URI, not fetched
    EaaRevocation = "http://uri.etsi.org/19602/SvcType/EAA/Revocation", // NOSONAR: ETSI identifier URI, not fetched
}

/** Default language for trust list entries */
const DEFAULT_LANG = "en";

/** Fields that change when a new version of a trust list is published. */
type TrustListVersionChanges = Pick<
    TrustList,
    "sequenceNumber" | "data" | "jwt"
> &
    Partial<Pick<TrustList, "description" | "keyChainId" | "entityConfig">>;

/**
 * A value that the input check of this list found, such as the certificate of
 * a key chain it names. A missing one is a programming error.
 */
function checked<K, V>(values: ReadonlyMap<K, V>, key: K, what: string): V {
    const value = values.get(key);
    if (value === undefined) {
        throw new Error(
            `${what} ${JSON.stringify(key)} was not checked for this trust list`,
        );
    }
    return value;
}

/**
 * The issue for a key chain field: the key chain does not exist, or `refusal`
 * refuses its usage type. None when it may be used.
 */
function keyChainIssues(
    path: TrustListInputIssue["path"],
    keyChainId: string,
    certificate: CertificateInfo | undefined,
    refusal: (usageType: unknown) => string | undefined,
): TrustListInputIssue[] {
    if (!certificate) return [keyChainNotFoundIssue(path, keyChainId)];
    const message = refusal(certificate.keyChain?.usageType);
    return message ? [{ path, message, code: "key_chain_usage_mismatch" }] : [];
}

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
        private readonly references: TrustListReferences,
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

    /**
     * The trust list for the management API. Unlike {@link findOne}, whose
     * callers include presentation and registrar flows that expect the
     * repository's error, a missing list is a `NotFoundException` whose
     * message the API returns in production too.
     * @throws NotFoundException when the tenant has no trust list with this ID
     */
    async get(tenantId: string, id: string): Promise<TrustList> {
        const trustList = await this.trustListRepo.findOneBy({ tenantId, id });
        if (!trustList) {
            throw new NotFoundException("Trust list not found");
        }
        return trustList;
    }

    /** @throws NotFoundException when the tenant has no trust list with this ID */
    async exportTrustList(
        tenantId: string,
        id: string,
    ): Promise<TrustListCreateDto> {
        return trustListConfig(await this.get(tenantId, id));
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
        const existing = await this.get(tenantId, id);
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
     * @throws NotFoundException when the tenant has no such trust list
     */
    async getVersionHistory(
        tenantId: string,
        trustListId: string,
    ): Promise<TrustListVersion[]> {
        if (
            !(await this.trustListRepo.existsBy({ tenantId, id: trustListId }))
        ) {
            throw new NotFoundException("Trust list not found");
        }
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
     * @throws NotFoundException when the tenant has no such list or version
     */
    async getVersion(
        tenantId: string,
        trustListId: string,
        versionId: string,
    ): Promise<TrustListVersion> {
        const version = await this.trustListVersionRepo.findOneBy({
            tenantId,
            trustListId,
            id: versionId,
        });
        if (!version) {
            throw new NotFoundException("Trust list version not found");
        }
        return version;
    }

    /**
     * Remove a trust list, whether configurations reference it or not
     * @param tenantId
     * @param id
     */
    async remove(tenantId: string, id: string): Promise<void> {
        await this.trustListRepo.delete({ tenantId, id });
    }

    /**
     * Remove a trust list that no presentation, credential or issuance
     * configuration of its tenant references. An unknown ID removes nothing.
     * @throws TrustListInUseError naming the configurations that reference it
     */
    async removeUnreferenced(tenantId: string, id: string): Promise<void> {
        if (!(await this.trustListRepo.existsBy({ tenantId, id }))) return;
        // Not atomic: a config saved between this lookup and the delete can
        // still name the list. Accepted for administrative CRUD; verification
        // then fails as it did before this check.
        const references = await this.references.find({ tenantId, id });
        if (references.length > 0) {
            throw new TrustListInUseError(id, references);
        }
        await this.remove(tenantId, id);
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
        const { signer, entries } = await this.checkedEntries(
            tenant.id,
            config,
            existing,
        );
        const cert = signer ?? (await this.defaultSigner(tenant.id, existing));

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
        return this.get(previous.tenantId, previous.id);
    }

    /** The LoTE entry of an entity whose input {@link checkedEntries} accepted. */
    private createEntity(
        entity: TrustListCreateDto["entities"][number],
        index: number,
        keyChainCertificates: ReadonlyMap<string, CertificateInfo>,
        externalCertificates: ReadonlyMap<number, ExternalEntityCertificates>,
    ): LoTETrustedEntity {
        if (entity.type === "internal") {
            // Internal: certificates of the key chains read above
            return this.createEntityFromCert(
                checked(
                    keyChainCertificates,
                    entity.issuerKeyChainId,
                    "Key chain",
                ),
                checked(
                    keyChainCertificates,
                    entity.revocationKeyChainId,
                    "Key chain",
                ),
                entity.info,
                entity.providerType,
            );
        }
        // External: the certificates parsed above, never the input as given
        const { issuerCertPem, revocationCertPem } = checked(
            externalCertificates,
            index,
            "Entity",
        );
        return this.createEntityFromData(
            issuerCertPem,
            revocationCertPem,
            entity.info,
            entity.providerType,
        );
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
                    ListIssueDateTime: trustListDateTime(now),
                    NextUpdate: trustListDateTime(trustListNextUpdate(now)),
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
     * Checks what the body schema cannot, and builds the LoTE entries of the
     * entities, all before a trust list key chain is picked: the key chains
     * the list names, read in one query, the external certificates and the
     * entity info. A key chain of another usage type that the stored list
     * already names in the same entity field is accepted.
     * @returns the certificate of `keyChainId`, when set, and the entries
     * @throws TrustListInputError with an issue at each refused field
     */
    private async checkedEntries(
        tenantId: string,
        config: TrustListCreateDto,
        existing: TrustList | undefined,
    ): Promise<{ signer?: CertificateInfo; entries: LoTETrustedEntity[] }> {
        const external = externalEntityCertificates(config.entities);
        const references = entityKeyChainReferences(config.entities);
        const certificates = await this.certService.getCertificatesByIds(
            tenantId,
            [
                ...(config.keyChainId ? [config.keyChainId] : []),
                ...references.map(({ keyChainId }) => keyChainId),
            ],
        );
        const { keyChainId } = config;
        const signer = keyChainId ? certificates.get(keyChainId) : undefined;

        const isStored = storedEntityKeyChains(existing?.entityConfig);
        const issues: TrustListInputIssue[] = [
            ...external.issues,
            ...(keyChainId
                ? keyChainIssues(
                      ["keyChainId"],
                      keyChainId,
                      signer,
                      (usageType) =>
                          trustListKeyChainUsageRefusal(
                              { id: keyChainId, kept: false },
                              usageType,
                          ),
                  )
                : []),
            ...references.flatMap((reference) =>
                keyChainIssues(
                    ["entities", reference.index, reference.field],
                    reference.keyChainId,
                    certificates.get(reference.keyChainId),
                    (usageType) =>
                        isStored(reference)
                            ? undefined
                            : entityKeyChainUsageRefusal(
                                  reference.field,
                                  reference.keyChainId,
                                  usageType,
                              ),
                ),
            ),
        ];
        if (issues.length > 0) {
            throw new TrustListInputError(issues);
        }
        return {
            signer,
            entries: this.createEntities(
                config.entities,
                certificates,
                external.certificates,
            ),
        };
    }

    /**
     * The LoTE entries of entities whose input {@link checkedEntries}
     * accepted.
     * @throws TrustListInputError at `entities.<index>.info` for entity info
     * the LoTE builder refuses although the body schema accepted it
     */
    private createEntities(
        entities: TrustListCreateDto["entities"],
        keyChainCertificates: ReadonlyMap<string, CertificateInfo>,
        externalCertificates: ReadonlyMap<number, ExternalEntityCertificates>,
    ): LoTETrustedEntity[] {
        const entries: LoTETrustedEntity[] = [];
        const issues: TrustListInputIssue[] = [];
        for (const [index, entity] of entities.entries()) {
            try {
                entries.push(
                    this.createEntity(
                        entity,
                        index,
                        keyChainCertificates,
                        externalCertificates,
                    ),
                );
            } catch (error) {
                if (!(error instanceof LoTEException)) throw error;
                issues.push({
                    path: ["entities", index, "info"],
                    message: error.message,
                    code: "invalid_entity_info",
                });
            }
        }
        if (issues.length > 0) {
            throw new TrustListInputError(issues);
        }
        return entries;
    }

    /**
     * The key chain that signs a list whose body names none: the one the
     * stored list is signed with, else a `trustList` key chain of the tenant,
     * whose certificate is also checked for expiry and revocation. A kept key
     * chain must still have usage type `trustList`; a key chain import that
     * reuses its ID can change it.
     * @throws ConflictException when none can sign: the body names no key
     * chain, so it is the stored state that blocks the save
     */
    private async defaultSigner(
        tenantId: string,
        existing: TrustList | undefined,
    ): Promise<CertificateInfo> {
        const kept = trustListSigningKeyChain(undefined, existing?.keyChainId);
        try {
            if (!kept) {
                return await this.certService.find({
                    tenantId,
                    type: KeyUsageType.TrustList,
                });
            }
            const cert = await this.certService.getCertificateById(
                tenantId,
                kept.id,
            );
            const refusal = trustListKeyChainUsageRefusal(
                kept,
                cert.keyChain?.usageType,
            );
            if (refusal) throw new ConflictException(refusal);
            return cert;
        } catch (error) {
            if (!(error instanceof NotFoundException)) throw error;
            throw new ConflictException(
                `${error.message}. Create a key chain with usage type "${KeyUsageType.TrustList}" or name one in keyChainId.`,
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
        return (await this.getVerifierAndSequenceNumber(tenantId, id))
            .verifierX509Der;
    }

    /**
     * The certificate that signs a managed trust list (base64 DER, see
     * {@link getVerifierX509Der}) and the list's current sequence number,
     * which the published list must not be lower than.
     */
    async getVerifierAndSequenceNumber(
        tenantId: string,
        id: string,
    ): Promise<{ verifierX509Der: string; sequenceNumber: number }> {
        const trustList = await this.findOne(tenantId, id);
        const cert = await this.certService.getCertificateById(
            tenantId,
            trustList.keyChainId,
        );
        // Pin the certificate whose key signs the JWT, rather than its root CA.
        return {
            verifierX509Der: this.formatPem(cert.crt[0]),
            sequenceNumber: trustList.sequenceNumber,
        };
    }

    /**
     * The current sequence number of a managed trust list, or undefined when
     * the tenant has no list with this ID.
     */
    async getSequenceNumber(
        tenantId: string,
        id: string,
    ): Promise<number | undefined> {
        const trustList = await this.trustListRepo.findOne({
            where: { tenantId, id },
            select: { tenantId: true, id: true, sequenceNumber: true },
        });
        return trustList?.sequenceNumber;
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
            algorithm: await this.keyChainService.getSigningAlg(
                trustList.tenantId,
                cert.keyId,
            ),
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
            lang,
        );

        // TEElectronicAddress (ETSI TS 119 602 clause 6.5.3.2): the e-mail
        // address as a mailto: URI and the web site, both required by
        // TrustListCreateSchema, then the optional telephone number. The
        // mailto: prefix is added here, not left to the builder, so the
        // published form does not depend on the library.
        entityBuilder.email(trustListMailtoUri(info.contactUri), lang);
        entityBuilder.website(info.website, lang);
        const entity = entityBuilder.build();
        if (info.phone) {
            // The builder has no telephone method; TEAddress exists, since
            // the postal address above is always set.
            entity.TrustedEntityInformation.TEAddress!.TEElectronicAddress.push(
                { lang, uriValue: trustListTelUri(info.phone) },
            );
        }
        return entity;
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
                    ? "http://uri.etsi.org/19602/LoTEType/EUWalletProvidersList" // NOSONAR: ETSI identifier URI, not fetched
                    : "http://uri.etsi.org/19602/LoTEType/EUEAAProvidersList", // NOSONAR: ETSI identifier URI, not fetched
                StatusDeterminationApproach: walletProviders
                    ? "http://uri.etsi.org/19602/WalletProvidersList/StatusDetn/EU" // NOSONAR: ETSI identifier URI, not fetched
                    : "http://uri.etsi.org/19602/EUEAAProvidersList/StatusDetn/EU", // NOSONAR: ETSI identifier URI, not fetched
                SchemeTypeCommunityRules: [
                    {
                        lang: DEFAULT_LANG,
                        uriValue: walletProviders
                            ? "http://uri.etsi.org/19602/WalletProvidersList/schemerules/EU" // NOSONAR: ETSI identifier URI, not fetched
                            : "http://uri.etsi.org/19602/EUEAAProviders/schemerules/EU", // NOSONAR: ETSI identifier URI, not fetched
                    },
                ],
                SchemeTerritory: "EU",
                ListIssueDateTime: trustListDateTime(issuedAt),
                NextUpdate: trustListDateTime(nextUpdate),
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
