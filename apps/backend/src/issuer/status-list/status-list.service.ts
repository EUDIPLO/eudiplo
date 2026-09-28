import { randomInt } from "node:crypto";
import {
    BadRequestException,
    ConflictException,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    ServiceUnavailableException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { SignatureAlgorithm } from "@owf/cose";
import {
    BitsPerStatus,
    createHeaderAndPayload,
    JWTwithStatusListPayload,
    StatusList,
    StatusListCwt,
    StatusListJWTHeaderParameters,
} from "@owf/token-status-list";
import { X509Certificate } from "@peculiar/x509";
import { JwtPayload } from "@sd-jwt/core";
import {
    DataSource,
    EntityManager,
    IsNull,
    type QueryRunner,
    Repository,
} from "typeorm";
import { v4 } from "uuid";
import { TenantEntity } from "../../auth/tenant/entities/tenant.entity.js";
import { CertService } from "../../crypto/key/cert/cert.service.js";
import { KeyChainService } from "../../crypto/key/key-chain.service.js";
import { KeyUsageType } from "../../crypto/key/types/key-usage-type.js";
import { ConfigImportService } from "../../platform/config-import/config-import.service.js";
import {
    ConfigImportOrchestratorService,
    ImportPhase,
} from "../../platform/config-import/config-import-orchestrator.service.js";
import type { SessionData as Session } from "../../session/domain/session-data.js";
import type { CredentialConfiguration } from "../configuration/credentials/domain/credential-configuration.js";
import { StatusListImportSchema } from "./dto/status-list.schema.js";
import { StatusListImportDto } from "./dto/status-list-import.dto.js";
import { StatusUpdateDto } from "./dto/status-update.dto.js";
import { ActiveCredentialSlot } from "./entities/active-credential-slot.entity.js";
import { StatusListEntity } from "./entities/status-list.entity.js";
import { StatusMapping } from "./entities/status-mapping.entity.js";
import { StatusListConfigService } from "./status-list-config.service.js";
import {
    STATUS_LIST_SETTINGS,
    type StatusListSettings,
} from "./status-list-settings.js";
import { SubjectKeyService } from "./subject-key.service.js";

/** The credential configuration fields that govern status entry allocation. */
type StatusEntryPolicy = Pick<
    CredentialConfiguration,
    "activeCredentials" | "statusManagement"
>;

/**
 * Status list value meaning "revoked", per the convention documented on
 * {@link StatusUpdateDto}: 0 = valid, 1 = revoked, 2 = suspended.
 */
const STATUS_REVOKED = 1;

interface EntryAllocationOptions {
    tenantId: string;
    sessionId: string;
    credentialConfigurationId: string;
    count: number;
    issuanceSetId?: string;
}

interface AllocatedStatusEntry {
    statusListId: string;
    index: number;
    uri: string;
}

/** Upper bound for status list capacity; each list is held in memory while it is created. */
export const MAX_STATUS_LIST_CAPACITY = 1_000_000;

@Injectable()
export class StatusListService {
    private readonly logger = new Logger(StatusListService.name);
    private readonly maxRetries = 3;

    /**
     * Tail of the promise chain used to serialise write transactions when the
     * driver cannot support concurrent ones (see {@link runSerialized}).
     */
    private writeQueue: Promise<unknown> = Promise.resolve();
    private readonly retryDelayMs = 100;

    constructor(
        @Inject(STATUS_LIST_SETTINGS)
        private readonly settings: StatusListSettings,
        private readonly certService: CertService,
        public readonly keyChainService: KeyChainService,
        private readonly dataSource: DataSource,
        @InjectRepository(StatusMapping)
        private readonly statusMappingRepository: Repository<StatusMapping>,
        @InjectRepository(StatusListEntity)
        private readonly statusListRepository: Repository<StatusListEntity>,
        @InjectRepository(TenantEntity)
        private readonly tenantRepository: Repository<TenantEntity>,
        private readonly configImportService: ConfigImportService,
        private readonly statusListConfigService: StatusListConfigService,
        readonly configImportOrchestrator: ConfigImportOrchestratorService,
        @InjectRepository(ActiveCredentialSlot)
        private readonly activeCredentialSlotRepository: Repository<ActiveCredentialSlot>,
        private readonly subjectKeyService: SubjectKeyService,
    ) {
        configImportOrchestrator.register(
            "status-lists",
            ImportPhase.FINAL,
            (tenantId) => this.importForTenant(tenantId),
        );
    }

    private async getSigningCert(entry: StatusListEntity) {
        // Use the pinned key chain if specified, otherwise use the tenant's default status list key chain.
        // Falls back to attestation key chains when no dedicated status list key exists.
        const cert = entry.keyChainId
            ? await this.certService.find({
                  tenantId: entry.tenantId,
                  type: KeyUsageType.StatusList,
                  fallbackType: KeyUsageType.Attestation,
                  keyId: entry.keyChainId,
              })
            : await this.certService.find({
                  tenantId: entry.tenantId,
                  type: KeyUsageType.StatusList,
                  fallbackType: KeyUsageType.Attestation,
              });

        if (!cert) {
            throw new NotFoundException(
                `Key chain ${entry.keyChainId} not found for tenant ${entry.tenantId}`,
            );
        }

        return cert;
    }

    /**
     * Get the effective status list capacity for a tenant.
     */
    private async getEffectiveCapacity(tenantId: string): Promise<number> {
        const tenant = await this.tenantRepository.findOneBy({ id: tenantId });
        return (
            tenant?.statusListConfig?.capacity ?? this.settings.statusCapacity
        );
    }

    /**
     * Get the effective bits per status for a tenant.
     */
    private async getEffectiveBits(tenantId: string): Promise<BitsPerStatus> {
        const tenant = await this.tenantRepository.findOneBy({ id: tenantId });
        return tenant?.statusListConfig?.bits ?? this.settings.statusBits;
    }

    /**
     * Cryptographically secure Fisher-Yates shuffle
     */
    private shuffleArray<T>(array: T[]): T[] {
        const shuffled = [...array];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = randomInt(0, i + 1);
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return shuffled;
    }

    /**
     * Build the URI for a status list.
     */
    private buildStatusListUri(tenantId: string, listId: string): string {
        const baseUrl = this.settings.publicUrl;
        return `${baseUrl}/issuers/${tenantId}/status-management/status-list/${listId}`;
    }

    /**
     * Build the aggregation URI for a tenant.
     * This endpoint returns all status list URIs for the tenant.
     * See RFC draft-ietf-oauth-status-list Section 9.
     */
    private buildAggregationUri(tenantId: string): string {
        const baseUrl = this.settings.publicUrl;
        return `${baseUrl}/issuers/${tenantId}/status-management/status-list-aggregation`;
    }

    /**
     * Create a new status list, optionally bound to a specific credential configuration and/or certificate.
     * @param tenantId The tenant ID
     * @param options Optional configuration for the new list
     * @returns The created status list entity
     */
    async createNewList(
        tenantId: string,
        options?: {
            credentialConfigurationId?: string;
            keyChainId?: string;
            bits?: BitsPerStatus;
            capacity?: number;
        },
    ): Promise<StatusListEntity> {
        const size =
            options?.capacity ?? (await this.getEffectiveCapacity(tenantId));
        // The capacity comes from API input or tenant configuration and sizes
        // in-memory arrays, so it must be bounded.
        if (
            !Number.isSafeInteger(size) ||
            size < 1 ||
            size > MAX_STATUS_LIST_CAPACITY
        ) {
            throw new BadRequestException(
                `Status list capacity must be an integer between 1 and ${MAX_STATUS_LIST_CAPACITY}`,
            );
        }
        // create an empty array with the size
        const elements = new Array(size).fill(0).map(() => 0);
        // create a list of indexes and shuffle them using crypto-secure randomness
        const stack = this.shuffleArray(
            new Array(size).fill(0).map((_, i) => i),
        );

        const bits = options?.bits ?? (await this.getEffectiveBits(tenantId));

        // Validate keyChainId if provided
        if (options?.keyChainId) {
            const cert = await this.certService.find({
                tenantId,
                type: KeyUsageType.StatusList,
                fallbackType: KeyUsageType.Attestation,
                keyId: options.keyChainId,
            });
            if (!cert) {
                throw new NotFoundException(
                    `Key chain ${options.keyChainId} not found for tenant ${tenantId}`,
                );
            }
        }

        const entry = await this.statusListRepository.save({
            id: v4(),
            tenantId,
            credentialConfigurationId:
                options?.credentialConfigurationId ?? null,
            keyChainId: options?.keyChainId ?? null,
            elements,
            stack,
            bits,
        });

        return this.regenerateListTokens(entry.tenantId, entry.id);
    }

    /**
     * Create status list tokens (JWT and CWT) and update the entity.
     * The JWT includes:
     * - `iat`: When the token was issued (REQUIRED)
     * - `exp`: When the token expires (RECOMMENDED)
     * - `ttl`: How long verifiers can cache before fetching fresh copy (RECOMMENDED)
     * - `aggregation_uri`: URI to fetch all status list URIs (OPTIONAL, per RFC Section 9)
     *
     * Uses optimistic locking to prevent stale token values from overwriting newer state.
     */
    async createListJWT(entry: StatusListEntity): Promise<boolean> {
        // Get TTL from tenant config or global default
        const effectiveConfig =
            await this.statusListConfigService.getEffectiveConfig(
                entry.tenantId,
            );
        const aggregationUri = effectiveConfig.enableAggregation
            ? this.buildAggregationUri(entry.tenantId)
            : undefined;
        const list = new StatusList(entry.elements, entry.bits, aggregationUri);
        const iss = this.settings.publicUrl;
        const sub = this.buildStatusListUri(entry.tenantId, entry.id);
        const ttl = effectiveConfig.ttl!;
        const now = Math.floor(Date.now() / 1000);
        const exp = now + ttl;

        const prePayload: JwtPayload = {
            iss,
            sub,
            iat: now,
            exp,
            ttl, // Maximum cache time in seconds for verifiers
        };

        const cert = await this.getSigningCert(entry);

        const preHeader: StatusListJWTHeaderParameters = {
            alg: "ES256",
            typ: "statuslist+jwt",
            x5c: this.certService.getLeafCertBase64(cert),
        };
        const { header, payload } = createHeaderAndPayload(
            list,
            prePayload,
            preHeader,
        );

        // Add aggregation_uri to status_list if enabled for this tenant (RFC Section 9.2)
        // This allows relying parties to pre-fetch all status lists for offline validation
        if (effectiveConfig.enableAggregation && payload.status_list) {
            (payload.status_list as Record<string, unknown>).aggregation_uri =
                aggregationUri;
        }

        const jwt = await this.keyChainService.signJWT(
            payload,
            header,
            entry.tenantId,
            cert.keyId,
        );

        const issuedAt = new Date(now * 1000);
        const expirationTime = new Date(exp * 1000);
        const cwt = await this.signStatusListCwt(
            entry.tenantId,
            cert.keyId,
            cert.crt,
            {
                subject: sub,
                issuedAt,
                expirationTime,
                ttl,
                statusList: list,
            },
        );

        // Only cache tokens if the entity still matches the snapshot that was signed.
        const expiresAt = new Date(exp * 1000);
        const updateResult = await this.statusListRepository.update(
            {
                id: entry.id,
                tenantId: entry.tenantId,
                version: entry.version,
            },
            {
                jwt,
                cwt: Buffer.from(cwt).toString("base64url"),
                expiresAt,
                version: () => "version + 1",
            },
        );

        if (updateResult.affected === 0) {
            // Version mismatch - entry was modified concurrently
            // Log but don't fail - JWT regeneration will be retried on next request
            this.logger.warn(
                `Stale JWT generation for list ${entry.id} (tenant: ${entry.tenantId}) - version changed concurrently`,
            );
            return false;
        }

        return true;
    }

    /**
     * Generate tokens from the latest status-list snapshot, retrying when the
     * list changes while the asynchronous signing operation is in progress.
     */
    private async regenerateListTokens(
        tenantId: string,
        listId: string,
    ): Promise<StatusListEntity> {
        for (let attempt = 0; attempt < this.maxRetries; attempt++) {
            const entry = await this.getListById(tenantId, listId);
            if (await this.createListJWT(entry)) {
                return this.getListById(tenantId, listId);
            }

            if (attempt < this.maxRetries - 1) {
                await this.delay(this.retryDelayMs * Math.pow(2, attempt));
            }
        }

        throw new ServiceUnavailableException(
            `Could not generate current tokens for status list ${listId}`,
        );
    }

    private async signStatusListCwt(
        tenantId: string,
        keyId: string,
        certChainPem: string[],
        payload: {
            subject: string;
            issuedAt: Date;
            expirationTime?: Date;
            ttl?: number;
            statusList: StatusList;
        },
    ): Promise<Uint8Array> {
        const x5chain = certChainPem.map(
            (pem) => new Uint8Array(new X509Certificate(pem).rawData),
        );

        const cwt = new StatusListCwt({
            payload: {
                subject: payload.subject,
                issuedAt: payload.issuedAt,
                expirationTime: payload.expirationTime,
                timeToLive: payload.ttl,
                statusList: payload.statusList,
            },
            protectedHeaders: new Map<number, unknown>([
                [1, SignatureAlgorithm.ES256],
                [4, new TextEncoder().encode(keyId)],
                // mDOC status verification expects x5chain in protected headers.
                [33, x5chain],
            ]),
        });

        return cwt.signAndEncode(
            {
                signingKey: { algorithm: SignatureAlgorithm.ES256 } as never,
                algorithm: SignatureAlgorithm.ES256,
            },
            {
                sign: async ({ toBeSigned }) =>
                    this.keyChainService.signBytes(toBeSigned, tenantId, keyId),
            },
        );
    }

    /**
     * Get all status lists for a tenant.
     * @param tenantId The ID of the tenant.
     * @returns Array of status lists.
     */
    async getLists(tenantId: string): Promise<StatusListEntity[]> {
        return this.statusListRepository.find({
            where: { tenantId },
            order: { createdAt: "ASC" },
        });
    }

    /**
     * Get all status list URIs for a tenant.
     * Used for the status list aggregation endpoint (RFC Section 9.3).
     * @param tenantId The ID of the tenant.
     * @returns Array of status list URIs.
     */
    async getStatusListUris(tenantId: string): Promise<string[]> {
        const lists = await this.getLists(tenantId);
        return lists.map((list) => this.buildStatusListUri(tenantId, list.id));
    }

    /**
     * Get a specific status list by ID.
     * @param tenantId The ID of the tenant.
     * @param listId The ID of the status list.
     * @returns The status list entity.
     */
    async getListById(
        tenantId: string,
        listId: string,
    ): Promise<StatusListEntity> {
        const list = await this.statusListRepository.findOneBy({
            id: listId,
            tenantId,
        });
        if (!list) {
            throw new NotFoundException(`Status list ${listId} not found`);
        }
        return list;
    }

    /**
     * Get the JWT for a specific status list.
     * @param tenantId The ID of the tenant.
     * @param listId The ID of the status list.
     * @returns The JWT for the status list.
     */
    async getListJwt(tenantId: string, listId: string): Promise<string> {
        let list = await this.getListById(tenantId, listId);

        // Check if JWT needs regeneration (expired or missing)
        const needsRegeneration =
            !list.jwt || !list.expiresAt || list.expiresAt <= new Date();

        if (needsRegeneration) {
            list = await this.regenerateListTokens(tenantId, listId);
        }

        return list.jwt!;
    }

    /**
     * Get the CWT for a specific status list.
     * The CWT follows the same caching/freshness policy as JWT status list tokens.
     */
    async getListCwt(tenantId: string, listId: string): Promise<Uint8Array> {
        let list = await this.getListById(tenantId, listId);

        const needsRegeneration =
            !list.jwt ||
            !list.cwt ||
            !list.expiresAt ||
            list.expiresAt <= new Date();

        if (needsRegeneration) {
            list = await this.regenerateListTokens(tenantId, listId);
        }

        return Uint8Array.from(Buffer.from(list.cwt!, "base64url"));
    }

    /**
     * Check if there are still free entries available for a credential configuration.
     * @param tenantId The tenant ID.
     * @param credentialConfigurationId The credential configuration ID.
     * @returns True if there are free entries.
     */
    async hasStillFreeEntries(
        tenantId: string,
        credentialConfigurationId?: string,
    ): Promise<boolean> {
        // Check for dedicated list first, then shared lists
        const list = await this.findAvailableList(
            tenantId,
            credentialConfigurationId,
        );
        return list !== null;
    }

    /**
     * Find an available status list with free entries.
     * Priority: dedicated list for the credential config > shared lists
     * @param tenantId The tenant ID.
     * @param credentialConfigurationId Optional credential config ID.
     * @returns The available list or null if none found.
     */
    private async findAvailableList(
        tenantId: string,
        credentialConfigurationId?: string,
    ): Promise<StatusListEntity | null> {
        // First, try to find a dedicated list for this credential config with free entries
        if (credentialConfigurationId) {
            const dedicatedList = await this.statusListRepository.findOne({
                where: {
                    tenantId,
                    credentialConfigurationId,
                    // TypeORM doesn't support array length checks directly,
                    // so we'll filter after fetching
                },
                order: { createdAt: "ASC" },
            });
            if (dedicatedList && dedicatedList.stack.length > 0) {
                return dedicatedList;
            }
        }

        // Then, try to find any shared list (credentialConfigurationId is null) with free entries
        const sharedLists = await this.statusListRepository.find({
            where: {
                tenantId,
                credentialConfigurationId: IsNull(),
            },
            order: { createdAt: "ASC" },
        });

        for (const list of sharedLists) {
            if (list.stack.length > 0) {
                return list;
            }
        }

        return null;
    }

    /**
     * Get the next free entry in the status list.
     * Automatically creates a new list if no available list is found.
     * Uses atomic batch allocation to prevent race conditions.
     * @param session The session for which to create the entry.
     * @param credentialConfigurationId The credential configuration ID.
     * @returns The status list payload to include in the credential.
     */
    async createEntry(
        session: Session,
        credentialConfigurationId: string,
        credentialConfiguration?: StatusEntryPolicy,
        issuanceSetId?: string,
    ): Promise<JWTwithStatusListPayload> {
        // Resolve the pseudonymous subject key when the active-credential-limit
        // policy applies to this issuance; undefined means "policy off" and the
        // behaviour below is unchanged from before.
        const subjectScopedKey = await this.resolveSubjectScopedKey(
            session,
            credentialConfigurationId,
            credentialConfiguration,
        );
        const activeIssuanceSetId = subjectScopedKey
            ? issuanceSetId
            : undefined;
        if (subjectScopedKey && !activeIssuanceSetId) {
            throw new ConflictException(
                "Active credential issuance requires an access token grouping identifier",
            );
        }

        const entry = await this.retryOnConcurrency(
            () =>
                this.allocateAndClaimEntry({
                    tenantId: session.tenantId,
                    sessionId: session.id,
                    credentialConfigurationId,
                    issuanceSetId: activeIssuanceSetId,
                    subjectScopedKey,
                }),
            "Could not allocate status entry after maximum retries",
        );

        return {
            status: {
                status_list: {
                    idx: entry.index,
                    uri: entry.uri,
                },
            },
        };
    }

    private async allocateAndClaimEntry(params: {
        tenantId: string;
        sessionId: string;
        credentialConfigurationId: string;
        issuanceSetId?: string;
        subjectScopedKey?: string;
    }): Promise<AllocatedStatusEntry> {
        const entries = await this.allocateEntries({ ...params, count: 1 });
        const entry = entries[0];
        if (!entry) {
            throw new ConflictException(
                "Failed to allocate status entry after retries",
            );
        }

        if (params.subjectScopedKey && params.issuanceSetId) {
            await this.replaceActiveIssuance({
                tenantId: params.tenantId,
                credentialConfigurationId: params.credentialConfigurationId,
                subjectScopedKey: params.subjectScopedKey,
                issuanceSetId: params.issuanceSetId,
            });
        }

        return entry;
    }

    /**
     * Resolve the pseudonymous subject key for the active-credential-limit
     * policy, or `undefined` when the policy does not apply to this issuance.
     *
     * Returns undefined when the configuration is absent, the policy is
     * disabled, status management is off (revocation needs status entries), or
     * no durable subject identity is available on the session.
     */
    private async resolveSubjectScopedKey(
        session: Session,
        credentialConfigurationId: string,
        credentialConfiguration?: StatusEntryPolicy,
    ): Promise<string | undefined> {
        const policy = credentialConfiguration?.activeCredentials;
        if (!policy?.enabled) {
            return undefined;
        }

        if (!credentialConfiguration?.statusManagement) {
            this.logger.warn(
                `activeCredentials is enabled for '${credentialConfigurationId}' but statusManagement is disabled; skipping enforcement.`,
            );
            return undefined;
        }

        const iss = session.externalIssuer;
        const sub = session.externalSubject;
        if (!iss || !sub) {
            // No durable per-user subject for this flow (for example the
            // built-in authorization server, whose `sub` is session-scoped).
            // Enforcing on a session-scoped subject would treat every issuance
            // as a new subject, so the policy is skipped instead.
            this.logger.debug(
                `No durable subject identity for session ${session.id}; skipping active-credential enforcement.`,
            );
            return undefined;
        }

        return this.subjectKeyService.deriveSubjectKey({
            tenantId: session.tenantId,
            credentialConfigurationId,
            iss,
            sub,
        });
    }

    /**
     * Point the subject's slot at the newly issued set and revoke whatever it
     * pointed at before.
     *
     * Concurrency rests on the unique constraint over
     * (tenantId, credentialConfigurationId, subjectScopedKey) rather than on
     * locking: two simultaneous first issuances both try to insert, exactly one
     * succeeds, and the loser falls through to the update path. Updates use the
     * slot's version as a compare-and-swap so a concurrent writer cannot be
     * silently overwritten. Whichever issuance commits last owns the slot, and
     * the set it displaced is revoked — so the subject converges on a single
     * active set either way.
     */
    private async replaceActiveIssuance(params: {
        tenantId: string;
        credentialConfigurationId: string;
        subjectScopedKey: string;
        issuanceSetId: string;
    }): Promise<void> {
        let previousIssuanceSetId: string | null = null;

        for (let attempt = 0; attempt < this.maxRetries; attempt++) {
            const existing = await this.activeCredentialSlotRepository.findOne({
                where: {
                    tenantId: params.tenantId,
                    credentialConfigurationId: params.credentialConfigurationId,
                    subjectScopedKey: params.subjectScopedKey,
                },
            });

            if (!existing) {
                try {
                    await this.activeCredentialSlotRepository.insert({
                        tenantId: params.tenantId,
                        credentialConfigurationId:
                            params.credentialConfigurationId,
                        subjectScopedKey: params.subjectScopedKey,
                        issuanceSetId: params.issuanceSetId,
                    });
                    // First issuance for this subject: nothing to revoke.
                    return;
                } catch (error) {
                    if (this.isUniqueViolation(error)) {
                        // Another issuance created the slot first; re-read and
                        // take the update path.
                        continue;
                    }
                    throw error;
                }
            }

            // More than one credential can be issued with the same access token
            // (for example, successive batch requests). They are one issuance
            // set, not replacements for one another.
            if (existing.issuanceSetId === params.issuanceSetId) {
                return;
            }

            const updateResult =
                await this.activeCredentialSlotRepository.update(
                    {
                        id: existing.id,
                        version: existing.version,
                    },
                    {
                        issuanceSetId: params.issuanceSetId,
                        version: () => "version + 1",
                    },
                );

            if (updateResult.affected === 0) {
                // Someone else advanced the slot between our read and write.
                await this.delay(this.retryDelayMs * Math.pow(2, attempt));
                continue;
            }

            previousIssuanceSetId = existing.issuanceSetId ?? null;
            break;
        }

        if (!previousIssuanceSetId) {
            return;
        }

        await this.revokeIssuanceSet(
            params.tenantId,
            params.credentialConfigurationId,
            previousIssuanceSetId,
        );
    }

    /**
     * Revoke every status entry belonging to one issuance set.
     *
     * Failures here leave the newly issued credential valid and the displaced
     * entries untouched, which is the safe direction: a stale credential that
     * outlives its replacement is recoverable, revoking a credential the holder
     * never replaced is not.
     */
    private async revokeIssuanceSet(
        tenantId: string,
        credentialConfigurationId: string,
        issuanceSetId: string,
    ): Promise<void> {
        const entries = await this.statusMappingRepository.findBy({
            tenantId,
            credentialConfigurationId,
            issuanceSetId,
        });

        for (const entry of entries) {
            await this.setEntry(
                entry.statusListId,
                entry.index,
                STATUS_REVOKED,
                tenantId,
            );
        }
    }

    /**
     * Whether an error is a database unique-constraint violation.
     * Matched by driver error code where available, falling back to the
     * constraint name for drivers that only surface a message.
     */
    private isUniqueViolation(error: unknown): boolean {
        if (!(error instanceof Error)) {
            return false;
        }
        const code = (error as { code?: string }).code;
        return (
            code === "23505" || // PostgreSQL unique_violation
            code === "SQLITE_CONSTRAINT_UNIQUE" ||
            code === "SQLITE_CONSTRAINT" ||
            error.message.includes("UQ_active_credential_slot_subject")
        );
    }

    /**
     * Allocate one or more status list entries atomically.
     * All entries for a single credential are allocated in one transaction,
     * ensuring consistency and preventing partial allocations.
     *
     * @param options Allocation request parameters
     * @returns Array of allocated entries
     */
    private async allocateEntries(
        options: EntryAllocationOptions,
    ): Promise<AllocatedStatusEntry[]> {
        return this.runSerialized(() =>
            this.allocateEntriesSerialized(options),
        );
    }

    private async allocateEntriesSerialized(
        options: EntryAllocationOptions,
    ): Promise<AllocatedStatusEntry[]> {
        const { entries, shouldCreateList } =
            await this.allocateEntriesTransaction(options);
        if (entries) {
            return entries;
        }

        if (shouldCreateList) {
            return this.createListAndAllocateEntries(options);
        }

        throw new ConflictException("No status list available for allocation");
    }

    /**
     * The transactional part of {@link allocateEntries}, kept separate so it
     * can be serialised as a unit. Creating a new list happens outside the
     * transaction, so it is reported back to the caller rather than done here.
     */
    private async allocateEntriesTransaction(
        options: EntryAllocationOptions,
    ): Promise<{
        entries?: AllocatedStatusEntry[];
        shouldCreateList: boolean;
    }> {
        const queryRunner = this.dataSource.createQueryRunner();
        let shouldCreateList = false;

        try {
            await queryRunner.connect();
            await queryRunner.startTransaction();

            const manager = queryRunner.manager;
            const list = await this.findAvailableListForAllocation(
                manager,
                options,
            );

            if (!list) {
                await queryRunner.commitTransaction();
                shouldCreateList = true;
            } else {
                const entries = await this.allocateFromList(
                    manager,
                    list,
                    options,
                );
                await queryRunner.commitTransaction();
                return { entries, shouldCreateList: false };
            }
        } catch (error) {
            await this.safeRollback(queryRunner);

            if (this.isRetryableConcurrencyError(error)) {
                throw new ConflictException(
                    "Status list index allocation conflict - please retry",
                );
            }

            throw error;
        } finally {
            await queryRunner.release();
        }

        return { shouldCreateList };
    }

    private async findAvailableListForAllocation(
        manager: EntityManager,
        options: EntryAllocationOptions,
    ): Promise<StatusListEntity | undefined> {
        const findFirstAvailable = (lists: StatusListEntity[]) =>
            lists.find((list) => list.stack.length >= options.count);
        const dedicatedLists = await manager.find(StatusListEntity, {
            where: {
                tenantId: options.tenantId,
                credentialConfigurationId: options.credentialConfigurationId,
            },
            order: { createdAt: "ASC" },
        });
        const dedicatedList = findFirstAvailable(dedicatedLists);
        if (dedicatedList) {
            return dedicatedList;
        }

        const sharedLists = await manager.find(StatusListEntity, {
            where: {
                tenantId: options.tenantId,
                credentialConfigurationId: IsNull(),
            },
            order: { createdAt: "ASC" },
        });
        return findFirstAvailable(sharedLists);
    }

    private async allocateFromList(
        manager: EntityManager,
        list: StatusListEntity,
        options: EntryAllocationOptions,
    ): Promise<AllocatedStatusEntry[]> {
        const allocatedIndices = Array.from({ length: options.count }, () => {
            const index = list.stack.pop();
            if (index === undefined) {
                throw new ConflictException(
                    "Stack underflow during allocation",
                );
            }
            return index;
        });
        const updateResult = await manager.update(
            StatusListEntity,
            {
                id: list.id,
                tenantId: options.tenantId,
                version: list.version,
            },
            {
                stack: list.stack,
                version: () => "version + 1",
            },
        );
        if (updateResult.affected === 0) {
            throw new ConflictException(
                "Status list was modified concurrently",
            );
        }

        const uri = this.buildStatusListUri(options.tenantId, list.id);
        await manager.insert(
            StatusMapping,
            allocatedIndices.map((index) => ({
                tenantId: options.tenantId,
                sessionId: options.sessionId,
                statusListId: list.id,
                index,
                list: uri,
                credentialConfigurationId: options.credentialConfigurationId,
                issuanceSetId: options.issuanceSetId ?? null,
            })),
        );
        return allocatedIndices.map((index) => ({
            statusListId: list.id,
            index,
            uri,
        }));
    }

    private async createListAndAllocateEntries(
        options: EntryAllocationOptions,
    ): Promise<AllocatedStatusEntry[]> {
        const newList = await this.createNewList(options.tenantId);
        if (newList.stack.length < options.count) {
            throw new ConflictException(
                "Status list capacity is smaller than the requested allocation",
            );
        }

        const { entries } = await this.allocateEntriesTransaction(options);
        if (!entries) {
            throw new ConflictException(
                "No status list available after creating a new list",
            );
        }

        return entries;
    }

    private async retryOnConcurrency<T>(
        operation: () => Promise<T>,
        unavailableMessage: string,
    ): Promise<T> {
        for (let attempt = 0; attempt < this.maxRetries; attempt++) {
            try {
                return await operation();
            } catch (error) {
                if (!this.isRetryableConcurrencyError(error)) {
                    throw error;
                }
                if (attempt < this.maxRetries - 1) {
                    await this.delay(this.retryDelayMs * Math.pow(2, attempt));
                }
            }
        }

        throw new ServiceUnavailableException(unavailableMessage);
    }

    /**
     * Whether the configured driver can run transactions from more than one
     * query runner at a time.
     *
     * TypeORM's SQLite drivers hand every query runner the same underlying
     * connection — `connect()` returns `driver.databaseConnection` — while
     * `isTransactionActive` and `transactionDepth` are per-runner fields. Two
     * runners therefore each believe they are at depth 0 and both issue
     * `BEGIN TRANSACTION` against one connection, which SQLite rejects. The
     * failure then surfaces from the rollback in the catch block, because the
     * per-runner flag says a transaction is active while the connection's real
     * transaction has already been committed or rolled back by the other
     * runner.
     */
    private supportsConcurrentTransactions(): boolean {
        return this.dataSource.driver.options.type !== "better-sqlite3";
    }

    /**
     * Run a write transaction, serialising it against other writes when the
     * driver cannot handle concurrent transactions.
     *
     * On PostgreSQL this is a straight pass-through and transactions run
     * concurrently as before. On SQLite the operations are chained so only one
     * transaction is open at a time, which is what the single shared
     * connection can actually support.
     *
     * This is deliberately not the integrity mechanism: correctness across
     * processes and instances still rests on the version checks and the unique
     * `(tenantId, statusListId, index)` constraint. Serialising only prevents a
     * single process from attempting something the driver cannot do.
     */
    private runSerialized<T>(operation: () => Promise<T>): Promise<T> {
        if (this.supportsConcurrentTransactions()) {
            return operation();
        }

        const result = this.writeQueue.then(operation, operation);
        // Keep the chain alive regardless of whether this operation settles
        // successfully, so one failure cannot stall every later write.
        this.writeQueue = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    /**
     * Roll back a transaction without letting the rollback itself mask the
     * error that caused it.
     *
     * `queryRunner.isTransactionActive` reflects per-runner state, so it can be
     * true while the shared connection has no open transaction. Attempting the
     * rollback anyway raises "cannot rollback - no transaction is active",
     * which would replace the original failure with a misleading one.
     */
    private async safeRollback(queryRunner: QueryRunner): Promise<void> {
        if (!queryRunner.isTransactionActive) {
            return;
        }

        try {
            await queryRunner.rollbackTransaction();
        } catch (rollbackError) {
            this.logger.debug(
                `Rollback skipped: ${
                    rollbackError instanceof Error
                        ? rollbackError.message
                        : String(rollbackError)
                }`,
            );
        }
    }

    /**
     * Helper function to introduce a delay for retry logic.
     */
    private delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    private isRetryableConcurrencyError(error: unknown): boolean {
        if (error instanceof ConflictException) {
            return true;
        }

        if (!(error instanceof Error)) {
            return false;
        }

        const databaseError = error as Error & {
            code?: string;
            driverError?: { code?: string };
        };
        const code = databaseError.driverError?.code ?? databaseError.code;
        if (
            code &&
            [
                "23505",
                "40001",
                "40P01",
                "SQLITE_BUSY",
                "SQLITE_BUSY_SNAPSHOT",
                "SQLITE_LOCKED",
            ].includes(code)
        ) {
            return true;
        }

        const message = error.message.toLowerCase();
        return (
            message.includes("version") ||
            message.includes("unique constraint") ||
            message.includes("database is locked")
        );
    }

    /**
     * Update the value of an entry in a specific status list.
     * Uses optimistic locking to ensure atomic updates and prevent lost writes.
     * JWT regeneration depends on the tenant's `immediateUpdate` setting:
     * - If true: JWT is regenerated immediately (after transaction commits)
     * - If false (default): JWT is only regenerated on next request when TTL expires
     * @param listId The ID of the status list.
     * @param index The index in the status list.
     * @param value The new status value.
     * @param tenantId The tenant ID.
     */
    private async setEntry(
        listId: string,
        index: number,
        value: number,
        tenantId: string,
    ): Promise<void> {
        for (let attempt = 0; attempt < this.maxRetries; attempt++) {
            try {
                await this.setEntryWithRetry(listId, index, value, tenantId);
                return;
            } catch (error) {
                if (this.isRetryableConcurrencyError(error)) {
                    if (attempt < this.maxRetries - 1) {
                        await this.delay(
                            this.retryDelayMs * Math.pow(2, attempt),
                        );
                        continue;
                    }
                    break;
                }
                throw error;
            }
        }

        throw new ServiceUnavailableException(
            "Could not update status entry after maximum retries",
        );
    }

    /**
     * Internal method that performs a single attempt to update an entry.
     */
    private async setEntryWithRetry(
        listId: string,
        index: number,
        value: number,
        tenantId: string,
    ): Promise<void> {
        const updateCommitted = await this.runSerialized(() =>
            this.setEntryTransaction(listId, index, value, tenantId),
        );

        if (updateCommitted) {
            const effectiveConfig =
                await this.statusListConfigService.getEffectiveConfig(tenantId);
            if (effectiveConfig.immediateUpdate) {
                await this.regenerateListTokens(tenantId, listId);
            }
        }
    }

    /**
     * The transactional part of {@link setEntryWithRetry}, separated so it can
     * be serialised as a unit. Token regeneration deliberately happens after
     * the transaction commits, so signing never runs inside it.
     */
    private async setEntryTransaction(
        listId: string,
        index: number,
        value: number,
        tenantId: string,
    ): Promise<boolean> {
        const queryRunner = this.dataSource.createQueryRunner();
        let updateCommitted = false;

        try {
            await queryRunner.connect();
            await queryRunner.startTransaction();

            const manager = queryRunner.manager;

            const entry = await manager.findOne(StatusListEntity, {
                where: { id: listId, tenantId },
            });

            if (!entry) {
                throw new NotFoundException(
                    `Status list ${listId} not found for tenant ${tenantId}`,
                );
            }

            // Modify the elements array
            const updatedElements = [...entry.elements];
            updatedElements[index] = value;

            // Perform atomic update with version check
            const updateResult = await manager.update(
                StatusListEntity,
                {
                    id: listId,
                    tenantId,
                    version: entry.version,
                },
                {
                    elements: updatedElements,
                    version: () => "version + 1",
                },
            );

            if (updateResult.affected === 0) {
                // Version mismatch - another transaction modified the list
                throw new ConflictException(
                    "Status list version changed concurrently",
                );
            }

            await queryRunner.commitTransaction();
            updateCommitted = true;
        } catch (error) {
            await this.safeRollback(queryRunner);
            throw error;
        } finally {
            await queryRunner.release();
        }

        return updateCommitted;
    }

    /**
     * Update the status of a session and its credential configuration.
     * @param value The status update DTO.
     * @param tenantId The tenant ID.
     */
    async updateStatus(
        value: StatusUpdateDto,
        tenantId: string,
    ): Promise<void> {
        const entries = await this.statusMappingRepository.findBy({
            tenantId,
            sessionId: value.sessionId,
            credentialConfigurationId: value.credentialConfigurationId,
        });
        if (entries.length === 0) {
            throw new ConflictException(
                `No status mapping found for session ${value.sessionId} and credential configuration ${value.credentialConfigurationId}`,
            );
        }
        for (const entry of entries) {
            await this.setEntry(
                entry.statusListId,
                entry.index,
                value.status,
                tenantId,
            );
        }
    }

    /**
     * Delete a status list by ID.
     * Only allows deletion if the list has no used entries.
     * @param tenantId The tenant ID.
     * @param listId The status list ID.
     */
    async deleteList(tenantId: string, listId: string): Promise<void> {
        // Verify the list exists (throws NotFoundException if not)
        await this.getListById(tenantId, listId);

        // Check if any entries are in use (mappings exist)
        const mappingsCount = await this.statusMappingRepository.countBy({
            tenantId,
            statusListId: listId,
        });

        if (mappingsCount > 0) {
            throw new ConflictException(
                `Cannot delete status list ${listId}: ${mappingsCount} credentials are using it`,
            );
        }

        await this.statusListRepository.delete({ id: listId, tenantId });
    }

    /**
     * Update a status list's configuration (credential binding and/or certificate).
     * @param tenantId The tenant ID.
     * @param listId The status list ID.
     * @param updates The updates to apply.
     */
    async updateList(
        tenantId: string,
        listId: string,
        updates: {
            credentialConfigurationId?: string | null;
            keyChainId?: string | null;
        },
    ): Promise<StatusListEntity> {
        const list = await this.getListById(tenantId, listId);

        // Validate new keyChainId if provided
        if (updates.keyChainId !== undefined && updates.keyChainId !== null) {
            const cert = await this.certService.find({
                tenantId,
                type: KeyUsageType.StatusList,
                fallbackType: KeyUsageType.Attestation,
                keyId: updates.keyChainId,
            });
            if (!cert) {
                throw new NotFoundException(
                    `Key chain ${updates.keyChainId} not found for tenant ${tenantId}`,
                );
            }
        }

        // Update bindings only. Saving the previously read entity could overwrite
        // status changes or allocations made while the certificate was validated.
        const changes: Partial<StatusListEntity> = {};
        if (updates.credentialConfigurationId !== undefined)
            changes.credentialConfigurationId =
                updates.credentialConfigurationId;
        if (updates.keyChainId !== undefined) {
            changes.keyChainId = updates.keyChainId;
            changes.jwt = null as any;
            changes.cwt = null as any;
            changes.expiresAt = null as any;
        }
        if (Object.keys(changes).length) {
            const result = await this.statusListRepository.update(
                { tenantId, id: listId, version: list.version },
                changes,
            );
            if (result.affected !== 1)
                throw new ConflictException(
                    "Status list changed concurrently; retry the update",
                );
        }
        return updates.keyChainId !== undefined
            ? this.regenerateListTokens(tenantId, listId)
            : this.getListById(tenantId, listId);
    }

    /**
     * Import status list configurations for a specific tenant.
     */
    async importForTenant(tenantId: string): Promise<void> {
        await this.configImportService.importConfigsForTenant<StatusListImportDto>(
            tenantId,
            {
                subfolder: "issuance/status-lists",
                fileExtension: ".json",
                validationSchema: StatusListImportSchema,
                resourceType: "status list",
                checkExists: async (tid, data) => {
                    // Check if a list with this ID already exists
                    const existing = await this.statusListRepository.findOneBy({
                        id: data.id,
                        tenantId: tid,
                    });
                    return existing !== null;
                },
                processItem: async (tid, config) => {
                    await this.processStatusListConfig(tid, config);
                },
            },
        );
    }

    /**
     * Process a status list config for import.
     */
    async processStatusListConfig(
        tenantId: string,
        config: StatusListImportDto,
    ) {
        const existing = await this.statusListRepository.findOneBy({
            tenantId,
            id: config.id,
        });
        if (existing) {
            if (
                (config.capacity !== undefined &&
                    config.capacity !== existing.elements.length) ||
                (config.bits !== undefined && config.bits !== existing.bits)
            ) {
                throw new BadRequestException(
                    "An existing status list cannot change capacity or bits; create a new list ID instead",
                );
            }
            await this.updateList(tenantId, config.id, {
                credentialConfigurationId: config.credentialConfigurationId,
                keyChainId: config.keyChainId,
            });
            return;
        }
        // Get effective size and bits (from config, tenant defaults, or global defaults)
        const size =
            config.capacity ?? (await this.getEffectiveCapacity(tenantId));
        const bits = config.bits ?? (await this.getEffectiveBits(tenantId));

        // Create the shuffled stack
        const elements = new Array(size).fill(0).map(() => 0);
        const stack = this.shuffleArray(
            new Array(size).fill(0).map((_, i) => i),
        );

        // Validate keyChainId if provided
        if (config.keyChainId) {
            const cert = await this.certService.find({
                tenantId,
                type: KeyUsageType.StatusList,
                fallbackType: KeyUsageType.Attestation,
                keyId: config.keyChainId,
            });
            if (!cert) {
                throw new Error(
                    `Key chain ${config.keyChainId} not found for tenant ${tenantId}`,
                );
            }
        }

        // Save with the provided ID
        await this.statusListRepository.insert({
            id: config.id,
            tenantId,
            credentialConfigurationId: config.credentialConfigurationId ?? null,
            keyChainId: config.keyChainId ?? null,
            elements,
            stack,
            bits,
        });

        await this.regenerateListTokens(tenantId, config.id);
    }
}
