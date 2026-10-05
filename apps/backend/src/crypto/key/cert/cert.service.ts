import { createHash } from "node:crypto";
import {
    BadRequestException,
    Injectable,
    Logger,
    NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as x509 from "@peculiar/x509";
import { KeyChainEntity } from "../entities/key-chain.entity.js";
import { KeyChainService } from "../key-chain.service.js";
import { KeyUsageType } from "../types/key-usage-type.js";
import { CrlValidationService } from "./crl-validation.service.js";

export interface FindCertOptions {
    tenantId: string;
    type: KeyUsageType;
    /**
     * Optional key chain ID to find a specific key chain.
     */
    keyId?: string;
    /**
     * Optional fallback usage type. If no key chain is found for the
     * primary `type`, a second lookup using this type is attempted.
     */
    fallbackType?: KeyUsageType;
    /**
     * Skip certificate validation (expiry and CRL check).
     * Default: false
     */
    skipValidation?: boolean;
}

/**
 * Result of certificate validation.
 */
export interface CertValidationResult {
    /** Whether the certificate passed all validations */
    isValid: boolean;
    /** Error message if validation failed */
    error?: string;
    /** Whether the certificate is expired */
    isExpired?: boolean;
    /** Whether the certificate is revoked */
    isRevoked?: boolean;
    /** Certificate expiry date */
    expiresAt?: Date;
    /** Certificate validity start date */
    validFrom?: Date;
}

/**
 * Virtual certificate entity for backward compatibility.
 * Maps KeyChainEntity data to the old CertEntity interface.
 */
export interface CertificateInfo {
    id: string;
    tenantId: string;
    crt: string[];
    description?: string;
    keyId: string;
    keyChain: KeyChainEntity;
}

/**
 * Service for managing certificates.
 *
 * In the new unified model, certificates are stored directly in KeyChainEntity
 * (activeCertificate, rootCertificate, previousCertificate).
 * This service provides a compatibility layer for existing consumers.
 */
@Injectable()
export class CertService {
    private readonly logger = new Logger(CertService.name);

    constructor(
        private readonly keyChainService: KeyChainService,
        private readonly configService: ConfigService,
        private readonly crlValidationService?: CrlValidationService,
    ) {}

    /**
     * Find a certificate by type (usage type).
     * Returns the certificate from the matching key chain.
     */
    async find(options: FindCertOptions): Promise<CertificateInfo> {
        const { tenantId, type, skipValidation, fallbackType } = options;
        const keyId = options.keyId;

        const keyChain = await this.keyChainService.findByUsageType(
            tenantId,
            type,
            keyId,
            fallbackType,
        );

        // Parse the certificate PEM to extract chain
        const certChain = this.parseCertificateChain(
            keyChain.activeCertificate,
        );

        const certInfo: CertificateInfo = {
            id: keyChain.id,
            tenantId,
            crt: certChain,
            description: keyChain.description,
            keyId: keyChain.id,
            keyChain,
        };

        if (!skipValidation) {
            const validation = await this.validateCertificate(certInfo);
            if (!validation.isValid) {
                throw new NotFoundException(
                    `Certificate validation failed: ${validation.error}`,
                );
            }
        }

        return certInfo;
    }

    /**
     * Find or create a certificate for a key chain.
     * In the new model, certificates are always created with the key chain,
     * so this just returns the existing one.
     */
    async findOrCreate(options: FindCertOptions): Promise<CertificateInfo> {
        return this.find(options);
    }

    /**
     * Get a certificate by ID (key chain ID).
     */
    async getCertificateById(
        tenantId: string,
        certId: string,
    ): Promise<CertificateInfo> {
        const keyChain = await this.keyChainService.getEntity(tenantId, certId);
        const certChain = this.parseCertificateChain(
            keyChain.activeCertificate,
        );

        return {
            id: keyChain.id,
            tenantId,
            crt: certChain,
            description: keyChain.description,
            keyId: keyChain.id,
            keyChain,
        };
    }

    /**
     * Get the certificate chain as an array of base64-encoded DER certificates.
     * Used for the x5c header in JWTs.
     *
     * Per JOSE/x5c usage, trust anchors must not be included in the presented
     * chain. If a root certificate is configured on the key chain and appears
     * as the trailing certificate in the active chain, it is removed.
     */
    getCertChain(cert: CertificateInfo): string[] {
        const chain = cert.crt.map((pem) => this.toBase64Der(pem));
        const rootPem = cert.keyChain?.rootCertificate;

        if (!rootPem) {
            return chain;
        }

        const rootBase64 = this.toBase64Der(rootPem);
        const lastIndex = chain.length - 1;

        if (lastIndex >= 0 && chain[lastIndex] === rootBase64) {
            const withoutRoot = chain.slice(0, -1);
            return withoutRoot.length > 0 ? withoutRoot : chain;
        }

        return chain;
    }

    /**
     * Get only the leaf (signing) certificate as a base64-encoded DER certificate array.
     * Used for x5c headers where only the signing certificate should be included (e.g., status lists).
     */
    getLeafCertBase64(cert: CertificateInfo): string[] {
        const leafPem = cert.crt[0];
        return [this.toBase64Der(leafPem)];
    }

    /**
     * Validate a certificate for expiry and revocation.
     */
    async validateCertificate(
        cert: CertificateInfo,
    ): Promise<CertValidationResult> {
        try {
            const leafPem = cert.crt[0];
            const x509Cert = new x509.X509Certificate(leafPem);
            const now = new Date();

            // Check expiry
            if (x509Cert.notAfter < now) {
                return {
                    isValid: false,
                    isExpired: true,
                    error: `Certificate expired on ${x509Cert.notAfter.toISOString()}`,
                    expiresAt: x509Cert.notAfter,
                    validFrom: x509Cert.notBefore,
                };
            }

            // Check CRL revocation if service is available. The CRL must be
            // signed by the leaf's issuer, which is in the rest of the chain
            // or is the key chain's root CA.
            if (this.crlValidationService) {
                const issuerCandidates = [
                    ...cert.crt.slice(1),
                    cert.keyChain?.rootCertificate,
                ].filter((pem): pem is string => !!pem);
                const crlResult =
                    await this.crlValidationService.checkCertificateRevocation(
                        leafPem,
                        issuerCandidates,
                    );
                if (!crlResult.isValid && crlResult.revokedAt) {
                    return {
                        isValid: false,
                        isRevoked: true,
                        error:
                            crlResult.reason || "Certificate has been revoked",
                        expiresAt: x509Cert.notAfter,
                        validFrom: x509Cert.notBefore,
                    };
                }
            }

            return {
                isValid: true,
                expiresAt: x509Cert.notAfter,
                validFrom: x509Cert.notBefore,
            };
        } catch (error: any) {
            return {
                isValid: false,
                error: `Failed to validate certificate: ${error.message}`,
            };
        }
    }

    /**
     * Get the hostname from the PUBLIC_URL config.
     */
    private getHostname(): string {
        return new URL(this.configService.getOrThrow<string>("PUBLIC_URL"))
            .hostname;
    }

    /**
     * Add an external certificate to an existing key chain.
     * Used for storing certificates obtained from external sources (e.g., registrar).
     */
    async addCertificate(
        tenantId: string,
        options: {
            crt: string[];
            keyId: string;
            description?: string;
        },
    ): Promise<string> {
        const { crt, keyId, description } = options;

        // Get the existing key chain
        const keyChain = await this.keyChainService.getEntity(tenantId, keyId);

        // Update the key chain with the new certificate
        await this.keyChainService.update(tenantId, keyId, {
            activeCertificate: crt.join("\n"),
            description: description || keyChain.description,
        });

        this.logger.log(
            `[${tenantId}] Added certificate to key chain ${keyId}`,
        );

        return keyId;
    }

    /**
     * Parse a PEM certificate chain into an array of PEM strings.
     */
    private parseCertificateChain(pemChain: string): string[] {
        const certs: string[] = [];
        const certRegex =
            /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
        let match;

        while ((match = certRegex.exec(pemChain)) !== null) {
            certs.push(match[0]);
        }

        // If no certificates found, treat the whole string as one cert
        if (certs.length === 0 && pemChain.includes("CERTIFICATE")) {
            certs.push(pemChain);
        }

        return certs;
    }

    /**
     * Compute the SHA-256 hash of the leaf certificate (for x509_hash client_id).
     * Returns the hash as a base64url-encoded string.
     */
    getCertHash(cert: CertificateInfo): string {
        const leafPem = cert.crt[0];
        const x509Cert = new x509.X509Certificate(leafPem);
        const hash = createHash("sha256")
            .update(Buffer.from(x509Cert.rawData))
            .digest();
        // Return as base64url (no padding)
        return hash.toString("base64url");
    }

    /**
     * Return the first DNS Subject Alternative Name from the leaf certificate.
     */
    getCertDnsName(cert: CertificateInfo): string {
        const leafPem = cert.crt[0];
        const x509Cert = new x509.X509Certificate(leafPem);
        const san = x509Cert.getExtension(x509.SubjectAlternativeNameExtension);
        const dnsName = san?.names.items.find((name) => name.type === x509.DNS);

        if (!dnsName) {
            throw new BadRequestException(
                "x509_san_dns requires a DNS Subject Alternative Name in the leaf certificate",
            );
        }

        return dnsName.value;
    }

    private toBase64Der(pem: string): string {
        try {
            const x509Cert = new x509.X509Certificate(pem);
            // Convert raw DER bytes to base64 (not base64url)
            return Buffer.from(x509Cert.rawData).toString("base64");
        } catch {
            // If parsing fails, try to extract base64 from PEM directly
            return pem
                .replace("-----BEGIN CERTIFICATE-----", "")
                .replace("-----END CERTIFICATE-----", "")
                .replace(/\s/g, "");
        }
    }
}
