import { createPrivateKey, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import {
    BadRequestException,
    ConflictException,
    Injectable,
    Logger,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import type { JWK } from "jose";
import { Repository } from "typeorm";
import { v4 } from "uuid";
import { TenantEntity } from "../../auth/tenant/entities/tenant.entity.js";
import { ConfigImportService } from "../../platform/config-import/config-import.service.js";
import {
    ConfigImportOrchestratorService,
    ImportPhase,
} from "../../platform/config-import/config-import-orchestrator.service.js";
import {
    CertificateBuilderService,
    certificateNotBefore,
} from "./cert/certificate-builder.service.js";
import { importedKeyChainType } from "./domain/key-chain-import-type.js";
import { certificateHoldsKey } from "./domain/public-jwk-match.js";
import { providerAlgRefusal, signingAlgForJwk } from "./domain/signing-algs.js";
import { KeyChainImportDto } from "./dto/key-chain-import.dto.js";
import { KeyChainEntity, KeyUsage } from "./entities/key-chain.entity.js";
import { importedRotationIntervals } from "./key-chain-import-rotation.js";
import type {
    KmsAdapter,
    KmsKeyRef,
    KmsSigningAlg,
} from "./kms/kms-adapter.js";
import { KmsProviderRegistry } from "./kms/kms-provider.registry.js";

// Avoids a backtracking-prone `=+$` regex by trimming padding with a bounded loop.
function stripTrailingPadding(value: string): string {
    let end = value.length;
    while (end > 0 && value[end - 1] === "=") {
        end -= 1;
    }
    return value.slice(0, end);
}

/**
 * Handles config-driven key-chain import and the config-import lifecycle hook.
 *
 * Keeps import logic isolated from the CRUD and signing concerns in
 * {@link KeyChainService} and {@link KeyChainSigningService}.
 */
@Injectable()
export class KeyChainImportService {
    private readonly logger = new Logger(KeyChainImportService.name);

    constructor(
        @InjectRepository(KeyChainEntity)
        private readonly keyChainRepository: Repository<KeyChainEntity>,
        @InjectRepository(TenantEntity)
        private readonly tenantRepository: Repository<TenantEntity>,
        private readonly configService: ConfigService,
        private readonly configImportService: ConfigImportService,
        private readonly kmsRegistry: KmsProviderRegistry,
        private readonly certBuilder: CertificateBuilderService,
        configImportOrchestrator: ConfigImportOrchestratorService,
    ) {
        configImportOrchestrator.register(
            "key-chains",
            ImportPhase.CORE,
            (tenantId) => this.importForTenant(tenantId),
        );
    }

    async importForTenant(tenantId: string): Promise<void> {
        await this.configImportService.importConfigsForTenant<KeyChainImportDto>(
            tenantId,
            {
                subfolder: "key-chains",
                fileExtension: ".json",
                validationSchema: KeyChainImportDto,
                resourceType: "key-chain",
                loadData: (filePath) => {
                    const payload = JSON.parse(readFileSync(filePath, "utf8"));
                    return payload as KeyChainImportDto;
                },
                checkExists: async (tid, data) => {
                    return await this.keyChainRepository
                        .count({
                            where: { tenantId: tid, id: data.id },
                        })
                        .then((count) => count > 0);
                },
                processItem: async (tid, config) => {
                    await this.importKeyChain(tid, config);
                },
            },
        );
    }

    async importKeyChain(
        tenantId: string,
        dto: KeyChainImportDto,
    ): Promise<string> {
        const id = dto.id || v4();
        const tenant = await this.tenantRepository.findOneByOrFail({
            id: tenantId,
        });
        const hostname = this.getHostname();

        const privateKey = this.resolvePrivateKey(dto);
        const existing = await this.keyChainRepository.findOne({
            where: { tenantId, id },
            select: { id: true, usage: true },
        });
        // Only signing key chains are user-manageable; an import must not
        // turn the tenant's encryption key chain into one.
        if (existing && existing.usage !== KeyUsage.Sign) {
            throw new ConflictException(
                `Key chain id ${id} belongs to a key chain that EUDIPLO manages itself. Use another id.`,
            );
        }
        const replacing = existing !== null;
        if (!privateKey.kid) {
            privateKey.kid = `${id}-active`;
        }
        const alg = this.signingAlgOf(privateKey);
        privateKey.alg = alg;

        const adapter = this.kmsRegistry.resolve(dto.kmsProvider, tenantId);
        // Checked before either import path hands the key to the provider.
        this.assertProviderSupports(adapter, alg);
        // External adapters must not overwrite the active key while a replacement is being validated.
        if (replacing && adapter.type !== "db")
            privateKey.kid = `${id}-import-${v4()}`;
        const normalizedCertificates = this.resolveCertificateChain(dto);
        const rotationEnabled = dto.rotationPolicy?.enabled ?? false;

        if (
            importedKeyChainType({ ...dto, crt: normalizedCertificates }) ===
            "internalChain"
        ) {
            return this.importInternalChain(
                id,
                tenantId,
                tenant.name,
                hostname,
                privateKey,
                adapter,
                dto,
            );
        }

        const activeMat = await adapter.importKey({
            kid: privateKey.kid,
            privateJwk: privateKey,
        });

        let activeCertificate: string;
        if (normalizedCertificates && normalizedCertificates.length > 0) {
            this.validateLeafCertificate(
                normalizedCertificates[0],
                activeMat.ref.publicJwk,
            );
            activeCertificate = normalizedCertificates.join("\n");
        } else {
            const now = new Date();
            const notAfter = new Date(
                now.getTime() + 365 * 24 * 60 * 60 * 1000,
            );
            activeCertificate = await this.certBuilder.createSelfSignedCert(
                adapter,
                activeMat.ref,
                tenant.name,
                hostname,
                certificateNotBefore(now),
                notAfter,
            );
        }

        const intervals = rotationEnabled
            ? importedRotationIntervals(dto.rotationPolicy)
            : undefined;
        await this.keyChainRepository.save({
            id,
            tenantId,
            usageType: dto.usageType,
            usage: KeyUsage.Sign,
            description: dto.description,
            kmsProvider: adapter.providerId,
            activeJwk: this.storedKeyForEntity(adapter, activeMat.ref),
            activeCertificate,
            externalKeyId: activeMat.ref.externalKeyId ?? (null as any),
            rootJwk: null as any,
            rootCertificate: null as any,
            rootExternalKeyId: null as any,
            rotationEnabled,
            rotationIntervalDays: intervals?.intervalDays ?? (null as any),
            certValidityDays: intervals?.certValidityDays ?? (null as any),
        });

        this.logger.log(
            `Imported key chain ${id} for tenant ${tenantId} (usage: ${dto.usageType}, provider: ${adapter.providerId}, rotation: ${rotationEnabled})`,
        );
        return id;
    }

    /** The algorithm of an imported key, from its curve; 400 for other keys. */
    private signingAlgOf(privateKey: JWK): KmsSigningAlg {
        try {
            return signingAlgForJwk(privateKey);
        } catch (error) {
            throw new BadRequestException(
                error instanceof Error ? error.message : String(error),
            );
        }
    }

    /** 400 when the provider's configured algorithms do not include `alg`. */
    private assertProviderSupports(
        adapter: KmsAdapter,
        alg: KmsSigningAlg,
    ): void {
        const refusal = providerAlgRefusal(
            adapter.providerId,
            adapter.capabilities.supportedAlgs,
            alg,
            "the imported key",
        );
        if (refusal) throw new BadRequestException(refusal);
    }

    private resolvePrivateKey(dto: KeyChainImportDto): JWK {
        if (dto.key) {
            return { ...dto.key };
        }

        if (!dto.keyPem) {
            throw new BadRequestException("An import requires key or keyPem.");
        }

        try {
            // The curve, and with it the algorithm, comes from the key.
            return createPrivateKey(dto.keyPem).export({
                format: "jwk",
            }) as JWK;
        } catch (error) {
            throw new BadRequestException(
                `Invalid PEM private key: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    /**
     * Imports `key` as the CA key of an internal chain and generates a new
     * signing key with a certificate issued by it.
     */
    private async importInternalChain(
        id: string,
        tenantId: string,
        subjectCN: string,
        hostname: string,
        rootKeyJwk: JWK,
        adapter: KmsAdapter,
        dto: KeyChainImportDto,
    ): Promise<string> {
        const now = new Date();
        const rotationEnabled = dto.rotationPolicy?.enabled ?? false;
        const { intervalDays, certValidityDays } = importedRotationIntervals(
            dto.rotationPolicy,
        );
        const notAfter = new Date(
            now.getTime() + certValidityDays * 24 * 60 * 60 * 1000,
        );

        rootKeyJwk.kid = rootKeyJwk.kid || `${id}-root`;
        const rootMat = await adapter.importKey({
            kid: rootKeyJwk.kid,
            privateJwk: rootKeyJwk,
        });

        let rootCertificate: string;
        const normalizedCertificates = this.resolveCertificateChain(dto);
        if (normalizedCertificates && normalizedCertificates.length > 0) {
            // `crt` is modeled as leaf-first. An internal chain needs the root
            // CA certificate that will sign newly generated leaf certificates.
            rootCertificate = normalizedCertificates.at(-1)!;
        } else {
            const rootNotAfter = new Date(
                now.getTime() + 10 * 365 * 24 * 60 * 60 * 1000,
            );
            rootCertificate = await this.certBuilder.createSelfSignedCaCert(
                adapter,
                rootMat.ref,
                `${subjectCN} Root CA`,
                hostname,
                certificateNotBefore(now),
                rootNotAfter,
            );
        }

        this.validateRootCertificate(rootCertificate, rootMat.ref.publicJwk);

        // The signing key uses the curve of the CA key.
        const activeMat = await adapter.generateKey({
            kid: `${id}-active-${Date.now()}`,
            alg: rootMat.ref.alg,
        });
        const { chain } = await this.certBuilder.createCaSignedCert({
            caAdapter: adapter,
            caRef: rootMat.ref,
            caCertPem: rootCertificate,
            subjectPublicJwk: activeMat.ref.publicJwk,
            subjectCN,
            hostname,
            notBefore: certificateNotBefore(now),
            notAfter,
        });

        await this.keyChainRepository.save({
            id,
            tenantId,
            usageType: dto.usageType,
            usage: KeyUsage.Sign,
            description: dto.description,
            kmsProvider: adapter.providerId,
            rootJwk: this.storedKeyForEntity(adapter, rootMat.ref),
            rootExternalKeyId: rootMat.ref.externalKeyId ?? (null as any),
            rootCertificate,
            activeJwk: this.storedKeyForEntity(adapter, activeMat.ref),
            activeCertificate: chain.join("\n"),
            externalKeyId: activeMat.ref.externalKeyId ?? (null as any),
            rotationEnabled,
            // Without rotation no intervals are stored, as for a standalone import.
            rotationIntervalDays: rotationEnabled
                ? intervalDays
                : (null as any),
            certValidityDays: rotationEnabled
                ? certValidityDays
                : (null as any),
        });

        this.logger.log(
            `Imported internal key chain ${id} for tenant ${tenantId} (usage: ${dto.usageType}, provider: ${adapter.providerId}, rotation: ${rotationEnabled})`,
        );
        return id;
    }

    /**
     * What gets persisted into the entity's JWK columns.
     * For `db` we keep the full private JWK; for external providers only the public JWK.
     */
    private storedKeyForEntity(adapter: KmsAdapter, ref: KmsKeyRef): JWK {
        if (adapter.type === "db" && ref.privateJwk) {
            return ref.privateJwk;
        }
        return ref.publicJwk;
    }

    private getHostname(): string {
        return new URL(this.configService.getOrThrow<string>("PUBLIC_URL"))
            .hostname;
    }

    private resolveCertificateChain(
        dto: KeyChainImportDto,
    ): string[] | undefined {
        if (!dto.crt || dto.crt.length === 0) {
            return undefined;
        }

        return dto.crt.map((entry, index) =>
            this.normalizeCertificateEntryToPem(entry, index),
        );
    }

    private normalizeCertificateEntryToPem(
        value: string,
        index: number,
    ): string {
        const trimmed = value.trim();
        if (this.isPemCertificate(trimmed)) {
            return trimmed;
        }

        try {
            const normalized = trimmed.replace(/\s+/g, "");
            const der = Buffer.from(normalized, "base64");
            if (der.length === 0) {
                throw new Error("decoded certificate is empty");
            }

            // Ensure the string was valid base64 before PEM wrapping.
            const canonical = stripTrailingPadding(der.toString("base64"));
            if (canonical !== stripTrailingPadding(normalized)) {
                throw new Error("input is not valid base64 DER");
            }

            // Canonical PEM formatting with 64-character lines.
            const body =
                der
                    .toString("base64")
                    .match(/.{1,64}/g)
                    ?.join("\n") ?? "";
            return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`;
        } catch (error) {
            throw new BadRequestException(
                `Invalid certificate at crt[${index}]. Expected PEM or base64 DER: ${String(error)}`,
            );
        }
    }

    private isPemCertificate(value: string): boolean {
        return (
            value.includes("-----BEGIN CERTIFICATE-----") &&
            value.includes("-----END CERTIFICATE-----")
        );
    }

    private validateRootCertificate(
        rootCertificatePem: string,
        expectedPublicJwk: JWK,
    ): void {
        let certificate: X509Certificate;
        try {
            certificate = new X509Certificate(rootCertificatePem);
        } catch (error) {
            throw new BadRequestException(
                `Invalid root CA certificate: ${String(error)}`,
            );
        }

        if (!certificate.ca) {
            throw new BadRequestException(
                "Invalid root CA certificate: certificate must be a CA (basicConstraints CA=true)",
            );
        }

        if (!certificateHoldsKey(certificate, expectedPublicJwk)) {
            throw new BadRequestException(
                "Invalid root CA certificate: certificate public key does not match the provided private key",
            );
        }
    }

    private validateLeafCertificate(
        leafCertificatePem: string,
        expectedPublicJwk: JWK,
    ): void {
        let certificate: X509Certificate;
        try {
            certificate = new X509Certificate(leafCertificatePem);
        } catch (error) {
            throw new BadRequestException(
                `Invalid leaf certificate: ${String(error)}`,
            );
        }

        if (!certificateHoldsKey(certificate, expectedPublicJwk)) {
            throw new BadRequestException(
                "Invalid leaf certificate: certificate public key does not match the provided private key",
            );
        }
    }
}
