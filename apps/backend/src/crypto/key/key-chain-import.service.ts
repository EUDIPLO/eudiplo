import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { exportJWK, importPKCS8, type JWK } from "jose";
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
import { KeyChainImportDto } from "./dto/key-chain-import.dto.js";
import { KeyChainEntity, KeyUsage } from "./entities/key-chain.entity.js";
import type { KmsAdapter, KmsKeyRef } from "./kms/kms-adapter.js";
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

        const privateKey = await this.resolvePrivateKey(dto);
        const replacing = await this.keyChainRepository.existsBy({
            tenantId,
            id,
        });
        if (!privateKey.kid) {
            privateKey.kid = `${id}-active`;
        }
        if (!privateKey.alg) {
            privateKey.alg = "ES256";
        }

        const adapter = this.kmsRegistry.resolve(dto.kmsProvider, tenantId);
        // External adapters must not overwrite the active key while a replacement is being validated.
        if (replacing && adapter.type !== "db")
            privateKey.kid = `${id}-import-${v4()}`;
        const normalizedCertificates = this.resolveCertificateChain(dto);

        if (dto.rotationPolicy?.enabled) {
            return this.importKeyChainWithRotation(
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
            rotationEnabled: false,
            rotationIntervalDays: null as any,
            certValidityDays: null as any,
        });

        this.logger.log(
            `Imported key chain ${id} for tenant ${tenantId} (usage: ${dto.usageType}, provider: ${adapter.providerId})`,
        );
        return id;
    }

    private async resolvePrivateKey(dto: KeyChainImportDto): Promise<JWK> {
        if (dto.key) {
            return { ...dto.key };
        }

        if (!dto.keyPem) {
            throw new BadRequestException("An import requires key or keyPem.");
        }

        try {
            const key = await importPKCS8(dto.keyPem, "ES256", {
                extractable: true,
            });
            return await exportJWK(key);
        } catch (error) {
            throw new BadRequestException(
                `Invalid PKCS#8 PEM private key: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    private async importKeyChainWithRotation(
        id: string,
        tenantId: string,
        subjectCN: string,
        hostname: string,
        rootKeyJwk: JWK,
        adapter: KmsAdapter,
        dto: KeyChainImportDto,
    ): Promise<string> {
        const now = new Date();
        const certValidityDays = dto.rotationPolicy?.certValidityDays || 365;
        const rotationIntervalDays = dto.rotationPolicy?.intervalDays || 90;
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
            // `crt` is modeled as leaf-first. In rotation mode we need the root CA
            // certificate that will sign newly generated leaf certificates.
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

        this.validateRotationRootCertificate(
            rootCertificate,
            rootMat.ref.publicJwk,
        );

        const activeMat = await adapter.generateKey({
            kid: `${id}-active-${Date.now()}`,
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
            rotationEnabled: true,
            rotationIntervalDays,
            certValidityDays,
        });

        this.logger.log(
            `Imported key chain ${id} with rotation for tenant ${tenantId} (usage: ${dto.usageType}, provider: ${adapter.providerId})`,
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

    private validateRotationRootCertificate(
        rootCertificatePem: string,
        expectedPublicJwk: JWK,
    ): void {
        let certificate: X509Certificate;
        try {
            certificate = new X509Certificate(rootCertificatePem);
        } catch (error) {
            throw new BadRequestException(
                `Invalid rotation root certificate: ${String(error)}`,
            );
        }

        if (!certificate.ca) {
            throw new BadRequestException(
                "Invalid rotation root certificate: certificate must be a CA (basicConstraints CA=true)",
            );
        }

        const certificatePublicJwk = certificate.publicKey.export({
            format: "jwk",
        }) as JWK;

        if (
            !this.arePublicJwksEquivalent(
                certificatePublicJwk,
                expectedPublicJwk,
            )
        ) {
            throw new BadRequestException(
                "Invalid rotation root certificate: certificate public key does not match the provided private key",
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

        const certificatePublicJwk = certificate.publicKey.export({
            format: "jwk",
        }) as JWK;

        if (
            !this.arePublicJwksEquivalent(
                certificatePublicJwk,
                expectedPublicJwk,
            )
        ) {
            throw new BadRequestException(
                "Invalid leaf certificate: certificate public key does not match the provided private key",
            );
        }
    }

    private arePublicJwksEquivalent(left: JWK, right: JWK): boolean {
        const a = left as Record<string, unknown>;
        const b = right as Record<string, unknown>;

        if (a.kty !== b.kty) {
            return false;
        }

        if (a.kty === "EC") {
            return a.crv === b.crv && a.x === b.x && a.y === b.y;
        }

        if (a.kty === "RSA") {
            return a.n === b.n && a.e === b.e;
        }

        if (a.kty === "OKP") {
            return a.crv === b.crv && a.x === b.x;
        }

        return false;
    }
}
