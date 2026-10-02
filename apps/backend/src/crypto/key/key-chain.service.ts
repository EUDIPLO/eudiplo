import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import * as x509 from "@peculiar/x509";
import type { Signer } from "@sd-jwt/core";
import type { JWK, JWSHeaderParameters, JWTPayload } from "jose";
import { Repository } from "typeorm";
import { v4 } from "uuid";
import { TenantEntity } from "../../auth/tenant/entities/tenant.entity.js";
import {
    CertificateBuilderService,
    certificateNotBefore,
} from "./cert/certificate-builder.service.js";
import { KeyChainCreateDto, KeyChainType } from "./dto/key-chain-create.dto.js";
import { KeyChainExportDto } from "./dto/key-chain-export.dto.js";
import { KeyChainImportDto } from "./dto/key-chain-import.dto.js";
import {
    CertificateInfoDto,
    KeyChainResponseDto,
    PublicKeyInfoDto,
} from "./dto/key-chain-response.dto.js";
import { KeyChainUpdateDto } from "./dto/key-chain-update.dto.js";
import { KmsProvidersResponseDto } from "./dto/kms-providers-response.dto.js";
import { KeyChainEntity, KeyUsage } from "./entities/key-chain.entity.js";
import { KeyChainImportService } from "./key-chain-import.service.js";
import { KeyChainSigningService } from "./key-chain-signing.service.js";
import type {
    KmsAdapter,
    KmsKeyRef,
    KmsSigningAlg,
} from "./kms/kms-adapter.js";
import { KmsProviderRegistry } from "./kms/kms-provider.registry.js";
import { KeyUsageType } from "./types/key-usage-type.js";

/**
 * KeyChainService manages the unified key chain model.
 *
 * Acts as a facade: all key generation, import and signing is delegated
 * to a {@link KmsAdapter} resolved via {@link KmsProviderRegistry}.
 * Certificate construction is delegated to
 * {@link CertificateBuilderService}.
 */
@Injectable()
export class KeyChainService {
    private readonly logger = new Logger(KeyChainService.name);

    constructor(
        @InjectRepository(KeyChainEntity)
        private readonly keyChainRepository: Repository<KeyChainEntity>,
        @InjectRepository(TenantEntity)
        private readonly tenantRepository: Repository<TenantEntity>,
        private readonly configService: ConfigService,
        private readonly kmsRegistry: KmsProviderRegistry,
        private readonly certBuilder: CertificateBuilderService,
        private readonly signingService: KeyChainSigningService,
        private readonly importService: KeyChainImportService,
    ) {}

    /** Return registered KMS providers (delegated to the registry). */
    getProviders(tenantId: string): KmsProvidersResponseDto {
        return this.kmsRegistry.list(tenantId);
    }

    /** Run a health probe for every registered KMS provider. */
    getProviderHealth(tenantId: string): Promise<
        Array<{
            providerId: string;
            type: string;
            ok: boolean;
            latencyMs?: number;
            error?: string;
        }>
    > {
        return this.kmsRegistry.health(tenantId);
    }

    async create(tenantId: string, dto: KeyChainCreateDto): Promise<string> {
        const id = v4();
        return this.createWithId(tenantId, id, dto);
    }

    /** Replace a key chain with newly generated material while preserving its id. */
    async regenerate(
        tenantId: string,
        id: string,
        dto: KeyChainCreateDto,
    ): Promise<string> {
        const previous = await this.keyChainRepository.findOneBy({
            tenantId,
            id,
        });
        const temporaryId = v4();
        await this.createWithId(tenantId, temporaryId, dto);
        const generated = await this.keyChainRepository.findOneByOrFail({
            tenantId,
            id: temporaryId,
        });
        try {
            await this.keyChainRepository.save({ ...generated, id });
            await this.keyChainRepository.delete({
                tenantId,
                id: temporaryId,
            });
        } catch (error) {
            await this.delete(tenantId, temporaryId);
            throw error;
        }
        if (previous) await this.deleteExternalKeyMaterial(previous);
        this.logger.log(`Regenerated key chain ${id} for tenant ${tenantId}`);
        return id;
    }

    private async createWithId(
        tenantId: string,
        id: string,
        dto: KeyChainCreateDto,
    ): Promise<string> {
        const tenant = await this.tenantRepository.findOneByOrFail({
            id: tenantId,
        });
        const hostname = this.getHostname();
        const subjectCN = tenant.name;

        const now = new Date();
        const certValidityDays = dto.rotationPolicy?.certValidityDays || 365;
        const notAfter = new Date(
            now.getTime() + certValidityDays * 24 * 60 * 60 * 1000,
        );

        const adapter = this.kmsRegistry.resolve(dto.kmsProvider, tenantId);

        let keyChain: Partial<KeyChainEntity>;

        if (dto.type === KeyChainType.InternalChain) {
            keyChain = await this.createInternalChain(
                id,
                adapter,
                subjectCN,
                hostname,
                certificateNotBefore(now),
                notAfter,
            );
        } else {
            keyChain = await this.createStandaloneKey(
                id,
                adapter,
                subjectCN,
                hostname,
                certificateNotBefore(now),
                notAfter,
            );
        }

        await this.keyChainRepository.save({
            ...keyChain,
            id,
            tenantId,
            usageType: dto.usageType,
            usage: KeyUsage.Sign,
            description: dto.description,
            kmsProvider: adapter.providerId,
            rotationEnabled: dto.rotationPolicy?.enabled ?? false,
            rotationIntervalDays: dto.rotationPolicy?.intervalDays,
            certValidityDays: dto.rotationPolicy?.certValidityDays,
        } as KeyChainEntity);

        this.logger.log(
            `Created key chain ${id} for tenant ${tenantId} (type: ${dto.type}, provider: ${adapter.providerId})`,
        );
        return id;
    }

    async createStandalone(options: {
        tenantId: string;
        description?: string;
        usageType: KeyUsageType;
        privateKey: JWK;
    }): Promise<string> {
        const id = v4();
        const { tenantId, privateKey, usageType, description } = options;

        if (!privateKey.kid) {
            privateKey.kid = `${id}-active`;
        }

        await this.keyChainRepository.save({
            id,
            tenantId,
            usageType,
            usage: KeyUsage.Encrypt,
            description: description || "Encryption key",
            kmsProvider: "db",
            activeJwk: privateKey,
            activeCertificate: "",
            rotationEnabled: false,
        } as KeyChainEntity);

        this.logger.log(
            `Created standalone key chain ${id} for tenant ${tenantId}`,
        );
        return id;
    }

    private async createInternalChain(
        id: string,
        adapter: KmsAdapter,
        subjectCN: string,
        hostname: string,
        notBefore: Date,
        notAfter: Date,
    ): Promise<Partial<KeyChainEntity>> {
        const rootMat = await adapter.generateKey({ kid: `${id}-root` });
        const rootNotAfter = new Date(
            notBefore.getTime() + 10 * 365 * 24 * 60 * 60 * 1000,
        );
        const rootCertificate = await this.certBuilder.createSelfSignedCaCert(
            adapter,
            rootMat.ref,
            `${subjectCN} Root CA`,
            hostname,
            notBefore,
            rootNotAfter,
        );

        const activeMat = await adapter.generateKey({ kid: `${id}-active` });
        const { chain } = await this.certBuilder.createCaSignedCert({
            caAdapter: adapter,
            caRef: rootMat.ref,
            caCertPem: rootCertificate,
            subjectPublicJwk: activeMat.ref.publicJwk,
            subjectCN,
            hostname,
            notBefore,
            notAfter,
        });

        return {
            rootJwk: this.storedKeyForEntity(adapter, rootMat.ref),
            rootExternalKeyId: rootMat.ref.externalKeyId,
            rootCertificate,
            activeJwk: this.storedKeyForEntity(adapter, activeMat.ref),
            activeCertificate: chain.join("\n"),
            externalKeyId: activeMat.ref.externalKeyId,
        };
    }

    private async createStandaloneKey(
        id: string,
        adapter: KmsAdapter,
        subjectCN: string,
        hostname: string,
        notBefore: Date,
        notAfter: Date,
    ): Promise<Partial<KeyChainEntity>> {
        const mat = await adapter.generateKey({ kid: `${id}-active` });
        const certificate = await this.certBuilder.createSelfSignedCert(
            adapter,
            mat.ref,
            subjectCN,
            hostname,
            notBefore,
            notAfter,
        );

        return {
            activeJwk: this.storedKeyForEntity(adapter, mat.ref),
            activeCertificate: certificate,
            externalKeyId: mat.ref.externalKeyId,
        };
    }

    async getAll(
        tenantId: string,
        usageType?: KeyUsageType,
    ): Promise<KeyChainResponseDto[]> {
        const keyChains = await this.keyChainRepository.find({
            // Only signing key chains are user-manageable. Tenant-wide
            // encryption material is system-owned and must not be exposed in
            // the key-management list.
            where: {
                tenantId,
                usage: KeyUsage.Sign,
                ...(usageType ? { usageType } : {}),
            },
        });

        return keyChains.map((kc) => this.toResponseDto(kc));
    }

    async getById(tenantId: string, id: string): Promise<KeyChainResponseDto> {
        const keyChain = await this.keyChainRepository.findOne({
            where: { tenantId, id },
        });

        if (!keyChain) {
            throw new NotFoundException(`Key chain ${id} not found`);
        }

        return this.toResponseDto(keyChain);
    }

    async export(tenantId: string, id: string): Promise<KeyChainExportDto> {
        const keyChain = await this.getEntity(tenantId, id);

        const exportDto: KeyChainExportDto = {
            id: keyChain.id,
            description: keyChain.description,
            usageType: keyChain.usageType,
            key: keyChain.hasInternalCa()
                ? (keyChain.rootJwk as KeyChainExportDto["key"])
                : (keyChain.activeJwk as KeyChainExportDto["key"]),
            kmsProvider: keyChain.kmsProvider,
        };

        const certs: string[] = [];
        if (keyChain.hasInternalCa()) {
            if (keyChain.rootCertificate) {
                certs.push(keyChain.rootCertificate.trim());
            }
        } else if (keyChain.activeCertificate) {
            certs.push(
                ...this.certBuilder.splitPemChain(keyChain.activeCertificate),
            );
        }
        if (certs.length > 0) {
            exportDto.crt = certs;
        }

        if (keyChain.rotationEnabled) {
            exportDto.rotationPolicy = {
                enabled: true,
                intervalDays: keyChain.rotationIntervalDays,
                certValidityDays: keyChain.certValidityDays,
            };
        }

        return exportDto;
    }

    async getEntity(tenantId: string, id: string): Promise<KeyChainEntity> {
        const keyChain = await this.keyChainRepository.findOne({
            where: { tenantId, id },
        });

        if (!keyChain) {
            throw new NotFoundException(`Key chain ${id} not found`);
        }

        return keyChain;
    }

    async findByUsageType(
        tenantId: string,
        usageType: KeyUsageType,
        keyId?: string,
        fallbackUsageType?: KeyUsageType,
    ): Promise<KeyChainEntity> {
        const whereClause: Record<string, unknown> = {
            tenantId,
            usageType,
        };

        if (keyId) {
            whereClause.id = keyId;
        }

        let keyChain = await this.keyChainRepository.findOne({
            where: whereClause,
        });

        if (!keyChain && fallbackUsageType) {
            const fallbackWhere: Record<string, unknown> = {
                tenantId,
                usageType: fallbackUsageType,
            };
            if (keyId) {
                fallbackWhere.id = keyId;
            }
            keyChain = await this.keyChainRepository.findOne({
                where: fallbackWhere,
            });
        }

        if (!keyChain) {
            const types = fallbackUsageType
                ? `'${usageType}' or '${fallbackUsageType}'`
                : `'${usageType}'`;
            throw new NotFoundException(
                `No key chain found with usage type ${types} for tenant ${tenantId}`,
            );
        }

        return keyChain;
    }

    async update(
        tenantId: string,
        id: string,
        dto: KeyChainUpdateDto,
    ): Promise<void> {
        await this.getEntity(tenantId, id);

        const updates: Partial<KeyChainEntity> = {};

        if (dto.description !== undefined) {
            updates.description = dto.description;
        }

        if (dto.rotationPolicy) {
            if (dto.rotationPolicy.enabled !== undefined) {
                updates.rotationEnabled = dto.rotationPolicy.enabled;
            }
            if (dto.rotationPolicy.intervalDays !== undefined) {
                updates.rotationIntervalDays = dto.rotationPolicy.intervalDays;
            }
            if (dto.rotationPolicy.certValidityDays !== undefined) {
                updates.certValidityDays = dto.rotationPolicy.certValidityDays;
            }
        }

        if (dto.activeCertificate !== undefined) {
            updates.activeCertificate = dto.activeCertificate;
        }

        await this.keyChainRepository.update({ tenantId, id }, updates);
        this.logger.log(`Updated key chain ${id}`);
    }

    async delete(tenantId: string, id: string): Promise<void> {
        const keyChain = await this.keyChainRepository.findOne({
            where: { tenantId, id },
        });
        if (!keyChain) {
            throw new NotFoundException(`Key chain ${id} not found`);
        }

        await this.deleteExternalKeyMaterial(keyChain);

        await this.keyChainRepository.delete({ tenantId, id });
        this.logger.log(`Deleted key chain ${id}`);
    }

    private async deleteExternalKeyMaterial(
        keyChain: KeyChainEntity,
    ): Promise<void> {
        // Best-effort: ask the adapter to clean up external key material.
        try {
            const adapter = this.kmsRegistry.resolve(
                keyChain.kmsProvider,
                keyChain.tenantId,
            );
            if (adapter.capabilities.canDelete) {
                await adapter.deleteKey(this.refFromEntity(keyChain));
            }
        } catch (err) {
            this.logger.warn(
                `Failed to delete external key material for key chain ${keyChain.id}: ${String(err)}`,
            );
        }
    }

    // ─────────────────────── config import ───────────────────────

    async importKeyChain(
        tenantId: string,
        dto: KeyChainImportDto,
    ): Promise<string> {
        return this.importService.importKeyChain(tenantId, dto);
    }

    async rotate(tenantId: string, id: string): Promise<void> {
        const keyChain = await this.getEntity(tenantId, id);
        const hostname = this.getHostname();
        const tenant = await this.tenantRepository.findOneByOrFail({
            id: tenantId,
        });
        const subjectCN = tenant.name;

        const now = new Date();
        const certValidityDays = keyChain.certValidityDays || 365;
        const notAfter = new Date(
            now.getTime() + certValidityDays * 24 * 60 * 60 * 1000,
        );

        const gracePeriodDays = 30;
        const previousKeyExpiry = new Date(
            now.getTime() + gracePeriodDays * 24 * 60 * 60 * 1000,
        );

        const previousJwk = keyChain.activeJwk;
        const previousCertificate = keyChain.activeCertificate;

        const adapter = this.kmsRegistry.resolve(
            keyChain.kmsProvider,
            keyChain.tenantId,
        );
        const newMat = await adapter.generateKey({
            kid: `${id}-${Date.now()}`,
        });

        let newCertificate: string;
        if (keyChain.hasInternalCa()) {
            // The root key already lives in the adapter's backing store.
            // Build a reference to it without re-importing (which would
            // create a duplicate key in external KMS backends).
            const caRef = this.refForStoredKey(
                adapter,
                keyChain.rootJwk!,
                keyChain.rootExternalKeyId ?? undefined,
            );
            const { chain } = await this.certBuilder.createCaSignedCert({
                caAdapter: adapter,
                caRef,
                caCertPem: keyChain.rootCertificate!,
                subjectPublicJwk: newMat.ref.publicJwk,
                subjectCN,
                hostname,
                notBefore: certificateNotBefore(now),
                notAfter,
            });
            newCertificate = chain.join("\n");
        } else {
            newCertificate = await this.certBuilder.createSelfSignedCert(
                adapter,
                newMat.ref,
                subjectCN,
                hostname,
                certificateNotBefore(now),
                notAfter,
            );
        }

        await this.keyChainRepository.update(
            { tenantId, id },
            {
                activeJwk: this.storedKeyForEntity(adapter, newMat.ref),
                activeCertificate: newCertificate,
                externalKeyId: newMat.ref.externalKeyId,
                previousJwk,
                previousCertificate,
                previousKeyExpiry,
                lastRotatedAt: now,
            },
        );

        this.logger.log(`Rotated key chain ${id}`);
    }

    async getActiveKey(tenantId: string, id: string): Promise<JWK> {
        const keyChain = await this.getEntity(tenantId, id);
        return keyChain.activeJwk;
    }

    async getPublicKeys(tenantId: string, id: string): Promise<JWK[]> {
        const keyChain = await this.getEntity(tenantId, id);
        return keyChain.getPublicKeys();
    }

    async getActiveCertificate(tenantId: string, id: string): Promise<string> {
        const keyChain = await this.getEntity(tenantId, id);
        return keyChain.activeCertificate;
    }

    // ─────────────────────────────────────────────────────────
    // SIGNING OPERATIONS — delegated to KeyChainSigningService
    // ─────────────────────────────────────────────────────────

    async signer(tenantId: string, keyId?: string): Promise<Signer> {
        return this.signingService.signer(tenantId, keyId);
    }

    async signJWT(
        payload: JWTPayload,
        header: JWSHeaderParameters,
        tenantId: string,
        keyId?: string,
    ): Promise<string> {
        return this.signingService.signJWT(payload, header, tenantId, keyId);
    }

    async signBytes(
        data: Uint8Array,
        tenantId: string,
        keyId?: string,
    ): Promise<Uint8Array> {
        return this.signingService.signBytes(data, tenantId, keyId);
    }

    async createCertificateSigningRequest(
        tenantId: string,
        keyId: string,
    ): Promise<string> {
        return this.signingService.createCertificateSigningRequest(
            tenantId,
            keyId,
        );
    }

    getPublicKey(type: "jwk", tenantId: string, keyId?: string): Promise<JWK>;
    getPublicKey(
        type: "pem",
        tenantId: string,
        keyId?: string,
    ): Promise<string>;
    getPublicKey(
        type: "pem" | "jwk",
        tenantId: string,
        keyId?: string,
    ): Promise<JWK | string> {
        if (type === "jwk") {
            return this.signingService.getPublicKey("jwk", tenantId, keyId);
        }
        return this.signingService.getPublicKey("pem", tenantId, keyId);
    }

    async getKid(tenantId: string): Promise<string> {
        return this.signingService.getKid(tenantId);
    }

    // ─────────────────────────────────────────────────────────
    // HELPER METHODS
    // ─────────────────────────────────────────────────────────

    private getHostname(): string {
        return new URL(this.configService.getOrThrow<string>("PUBLIC_URL"))
            .hostname;
    }

    /**
     * What gets persisted into the entity's `activeJwk` / `rootJwk` JWK
     * column. For the `db` provider we keep the full private JWK (so
     * signing can re-import it). For external providers we keep only
     * the public JWK — the private key lives in the KMS backend.
     */
    private storedKeyForEntity(adapter: KmsAdapter, ref: KmsKeyRef): JWK {
        if (adapter.type === "db" && ref.privateJwk) {
            return ref.privateJwk;
        }
        return ref.publicJwk;
    }

    /**
     * Reconstruct a {@link KmsKeyRef} from a persisted entity so the
     * adapter can sign / delete.
     */
    private refFromEntity(keyChain: KeyChainEntity): KmsKeyRef {
        return this.refForStoredKey(
            this.kmsRegistry.resolve(keyChain.kmsProvider, keyChain.tenantId),
            keyChain.activeJwk,
            keyChain.externalKeyId ?? undefined,
        );
    }

    /**
     * Build a {@link KmsKeyRef} for any stored JWK (active or root).
     *
     * - `db` provider: the stored JWK is the private JWK; derive the
     *   public JWK from it.
     * - external providers: the stored JWK is the public JWK; the
     *   private key lives in the backend, identified by
     *   `externalKeyId` (falling back to `storedJwk.kid` which is
     *   what adapters use as the external key identifier).
     */
    private refForStoredKey(
        adapter: KmsAdapter,
        storedJwk: JWK,
        externalKeyId?: string,
    ): KmsKeyRef {
        const alg =
            (storedJwk.alg as KmsSigningAlg | undefined) ??
            adapter.capabilities.defaultAlg;
        if (adapter.type === "db") {
            const publicJwk = this.getPublicJwk(storedJwk);
            return { privateJwk: storedJwk, publicJwk, alg };
        }
        return {
            externalKeyId: externalKeyId ?? storedJwk.kid,
            publicJwk: storedJwk,
            alg,
        };
    }

    private getPublicJwk(jwk: JWK): JWK {
        const { d, p, q, dp, dq, qi, k, ...publicJwk } = jwk as Record<
            string,
            unknown
        >;
        return publicJwk as JWK;
    }

    private toResponseDto(keyChain: KeyChainEntity): KeyChainResponseDto {
        const type = keyChain.hasInternalCa()
            ? KeyChainType.InternalChain
            : KeyChainType.Standalone;

        const response: KeyChainResponseDto = {
            id: keyChain.id,
            usageType: keyChain.usageType,
            type,
            description: keyChain.description,
            kmsProvider: keyChain.kmsProvider,
            activePublicKey: this.toPublicKeyInfo(keyChain.activeJwk),
            rotationPolicy: {
                enabled: keyChain.rotationEnabled,
                intervalDays: keyChain.rotationIntervalDays,
                certValidityDays: keyChain.certValidityDays,
                nextRotationAt: this.calculateNextRotation(keyChain),
            },
            createdAt: keyChain.createdAt,
            updatedAt: keyChain.updatedAt,
        };

        if (keyChain.activeCertificate) {
            response.activeCertificate = this.toCertificateInfo(
                keyChain.activeCertificate,
            );
        }

        if (keyChain.rootCertificate) {
            response.rootCertificate = this.toCertificateInfo(
                keyChain.rootCertificate,
            );
        }

        if (keyChain.previousJwk) {
            response.previousPublicKey = this.toPublicKeyInfo(
                keyChain.previousJwk,
            );
            response.previousCertificate = this.toCertificateInfo(
                keyChain.previousCertificate!,
            );
            response.previousKeyExpiry = keyChain.previousKeyExpiry;
        }

        return response;
    }

    private toPublicKeyInfo(jwk: JWK): PublicKeyInfoDto {
        const publicJwk = this.getPublicJwk(jwk);
        return {
            kty: publicJwk.kty as string,
            alg: publicJwk.alg as string | undefined,
            kid: publicJwk.kid as string | undefined,
            crv: (publicJwk as Record<string, unknown>).crv as
                | string
                | undefined,
        };
    }

    private toCertificateInfo(pem: string): CertificateInfoDto {
        const firstCertPem =
            pem.split("-----END CERTIFICATE-----")[0] +
            "-----END CERTIFICATE-----";

        try {
            const cert = new x509.X509Certificate(firstCertPem);
            return {
                pem,
                subject: cert.subject,
                issuer: cert.issuer,
                notBefore: cert.notBefore,
                notAfter: cert.notAfter,
                serialNumber: cert.serialNumber,
            };
        } catch {
            return { pem };
        }
    }

    private calculateNextRotation(keyChain: KeyChainEntity): Date | undefined {
        if (!keyChain.rotationEnabled || !keyChain.rotationIntervalDays) {
            return undefined;
        }

        const baseDate = keyChain.lastRotatedAt || keyChain.createdAt;
        return new Date(
            baseDate.getTime() +
                keyChain.rotationIntervalDays * 24 * 60 * 60 * 1000,
        );
    }
}
