import { Injectable, Logger } from "@nestjs/common";
import { AsnParser } from "@peculiar/asn1-schema";
import { CertificateList } from "@peculiar/asn1-x509";
import * as x509 from "@peculiar/x509";
import { OutboundUrlPolicyService } from "../../../webhook/outbound-url-policy.service.js";

/** Upper bound for a CRL download. */
const CRL_MAX_BYTES = 20 * 1024 * 1024;

/** The axios client used for CRL downloads before followed five redirects. */
const CRL_MAX_REDIRECTS = 5;

/**
 * Cached CRL with metadata.
 */
interface CachedCrl {
    /** The parsed CRL */
    crl: CertificateList;
    /** When the cache entry was fetched */
    fetchedAt: number;
    /** Next update time from the CRL (if available) */
    nextUpdate?: Date;
}

/**
 * Result of a CRL validation check.
 */
export interface CrlValidationResult {
    /** Whether the certificate is valid (not revoked) */
    isValid: boolean;
    /** If revoked, the revocation date */
    revokedAt?: Date;
    /** If revoked, the reason code */
    reason?: string;
    /** Error message if validation failed */
    error?: string;
    /** Whether CRL was fetched from cache */
    fromCache?: boolean;
}

/**
 * Service for validating certificates against Certificate Revocation Lists (CRL).
 *
 * This service:
 * - Extracts CRL Distribution Points from certificates
 * - Fetches and caches CRL data
 * - Checks if certificates are revoked
 */
@Injectable()
export class CrlValidationService {
    private readonly logger = new Logger(CrlValidationService.name);
    private readonly crlCache = new Map<string, CachedCrl>();

    /**
     * Short-lived cache for certificate validation results.
     * Prevents repeated validation of the same certificate within a request.
     * Key is the certificate fingerprint, value is the result and timestamp.
     */
    private readonly certValidationCache = new Map<
        string,
        { result: CrlValidationResult; timestamp: number }
    >();

    /** Cache TTL for certificate validation results (30 seconds) */
    private readonly certValidationCacheTtlMs = 30 * 1000;

    /** Default cache TTL in milliseconds (1 hour) */
    private readonly defaultCacheTtlMs = 60 * 60 * 1000;

    /** Timeout for CRL fetch in milliseconds */
    private readonly fetchTimeoutMs = 10000;

    constructor(private readonly outboundUrlPolicy: OutboundUrlPolicyService) {}

    /**
     * Check if a certificate is revoked according to its CRL.
     *
     * @param certPem - PEM-encoded certificate to check
     * @returns CRL validation result
     */
    async checkCertificateRevocation(
        certPem: string,
    ): Promise<CrlValidationResult> {
        try {
            const cert = new x509.X509Certificate(certPem);

            // Check certificate validation cache first (avoids repeated validation within short window)
            const certFingerprint = await cert.getThumbprint("SHA-256");
            const cacheKey = Buffer.from(certFingerprint).toString("hex");
            const cached = this.certValidationCache.get(cacheKey);
            if (
                cached &&
                Date.now() - cached.timestamp < this.certValidationCacheTtlMs
            ) {
                return { ...cached.result, fromCache: true };
            }

            const crlUrls = this.extractCrlDistributionPoints(cert);

            if (crlUrls.length === 0) {
                this.logger.debug(
                    `No CRL Distribution Points found in certificate ${cert.subject}`,
                );
                return {
                    isValid: true,
                    error: "No CRL Distribution Points in certificate",
                };
            }

            // Try each CRL URL until we get a successful check
            for (const url of crlUrls) {
                try {
                    const result = await this.checkAgainstCrl(cert, url);
                    // Cache the result
                    this.certValidationCache.set(cacheKey, {
                        result,
                        timestamp: Date.now(),
                    });
                    return result;
                } catch (error: any) {
                    this.logger.warn(
                        `Failed to check CRL at ${url}: ${error.message}`,
                    );
                    continue;
                }
            }

            // All CRL URLs failed
            const failResult: CrlValidationResult = {
                isValid: false,
                error: `Failed to validate against any CRL: ${crlUrls.join(", ")}`,
            };
            this.certValidationCache.set(cacheKey, {
                result: failResult,
                timestamp: Date.now(),
            });
            return failResult;
        } catch (error: any) {
            this.logger.error(
                `CRL validation error: ${error.message}`,
                error.stack,
            );
            return {
                isValid: false,
                error: `CRL validation failed: ${error.message}`,
            };
        }
    }

    /**
     * Extract CRL Distribution Point URLs from a certificate.
     *
     * @param cert - The X.509 certificate
     * @returns Array of CRL URLs
     */
    extractCrlDistributionPoints(cert: x509.X509Certificate): string[] {
        const urls: string[] = [];

        // CRL Distribution Points OID: 2.5.29.31
        const cdpExtension = cert.getExtension("2.5.29.31");
        if (!cdpExtension) {
            return urls;
        }

        try {
            // The extension value is ASN.1 encoded
            // CRLDistributionPoints ::= SEQUENCE SIZE (1..MAX) OF DistributionPoint
            // We need to parse the raw value to extract URLs
            const extValue = (cdpExtension as any).value;

            if (extValue && typeof extValue === "object") {
                // @peculiar/x509 may provide parsed data
                this.extractUrlsFromParsedCdp(extValue, urls);
            }

            // If we couldn't extract from parsed data, try raw ASN.1
            if (urls.length === 0 && cdpExtension.rawData) {
                this.extractUrlsFromRawCdp(cdpExtension.rawData, urls);
            }
        } catch (error: any) {
            this.logger.warn(
                `Failed to parse CRL Distribution Points: ${error.message}`,
            );
        }

        return urls;
    }

    /**
     * Extract URLs from parsed CDP extension data.
     */
    private extractUrlsFromParsedCdp(value: any, urls: string[]): void {
        if (Array.isArray(value)) {
            for (const item of value) {
                this.extractUrlsFromParsedCdp(item, urls);
            }
        } else if (typeof value === "object" && value !== null) {
            // Look for fullName or uniformResourceIdentifier
            if (value.type === "url" && typeof value.value === "string") {
                urls.push(value.value);
            } else if (
                value.uniformResourceIdentifier &&
                typeof value.uniformResourceIdentifier === "string"
            ) {
                urls.push(value.uniformResourceIdentifier);
            } else if (value.fullName) {
                this.extractUrlsFromParsedCdp(value.fullName, urls);
            } else if (value.distributionPoint) {
                this.extractUrlsFromParsedCdp(value.distributionPoint, urls);
            } else {
                // Recursively check all properties
                for (const key of Object.keys(value)) {
                    this.extractUrlsFromParsedCdp(value[key], urls);
                }
            }
        } else if (
            typeof value === "string" &&
            (value.startsWith("http://") || value.startsWith("https://"))
        ) {
            urls.push(value);
        }
    }

    /**
     * Extract URLs from raw ASN.1 CDP extension data.
     * This is a fallback when the library doesn't parse it for us.
     */
    private extractUrlsFromRawCdp(rawData: ArrayBuffer, urls: string[]): void {
        const bytes = new Uint8Array(rawData);
        const str = new TextDecoder("utf-8", { fatal: false }).decode(bytes);

        // Simple regex to find HTTP URLs in the raw data
        // Match only printable ASCII characters (space 0x20 to tilde 0x7E)
        const urlRegex = /https?:\/\/[\u0020-\u007E]+/g;
        const matches = str.match(urlRegex);
        if (matches) {
            for (const match of matches) {
                // Clean up any trailing non-printable characters
                const cleanUrl = match.replace(/[^\u0020-\u007E]/g, "");
                if (
                    cleanUrl.startsWith("http://") ||
                    cleanUrl.startsWith("https://")
                ) {
                    urls.push(cleanUrl);
                }
            }
        }
    }

    /**
     * Check a certificate against a specific CRL URL.
     */
    private async checkAgainstCrl(
        cert: x509.X509Certificate,
        crlUrl: string,
    ): Promise<CrlValidationResult> {
        const crl = await this.fetchCrl(crlUrl);
        const serialNumber = cert.serialNumber;

        // Check if the certificate is in the revoked certificates list
        const revokedCerts = crl.tbsCertList.revokedCertificates;

        if (!revokedCerts || revokedCerts.length === 0) {
            return { isValid: true, fromCache: this.crlCache.has(crlUrl) };
        }

        for (const revoked of revokedCerts) {
            // Convert serial numbers to comparable format
            // userCertificate is an ArrayBuffer in @peculiar/asn1-x509
            const revokedSerial = this.arrayBufferToHex(
                revoked.userCertificate as unknown as ArrayBuffer,
            );
            const certSerial = serialNumber.toLowerCase().replaceAll(":", "");

            if (revokedSerial === certSerial) {
                const revokedAt = revoked.revocationDate.getTime();
                let reason: string | undefined;

                // Try to extract revocation reason from extensions
                if (revoked.crlEntryExtensions) {
                    for (const ext of revoked.crlEntryExtensions) {
                        // Reason Code OID: 2.5.29.21
                        if (ext.extnID === "2.5.29.21") {
                            reason = this.parseReasonCode(
                                ext.extnValue as unknown as ArrayBuffer,
                            );
                        }
                    }
                }

                return {
                    isValid: false,
                    revokedAt: new Date(revokedAt),
                    reason,
                    fromCache: this.crlCache.has(crlUrl),
                };
            }
        }

        return { isValid: true, fromCache: this.crlCache.has(crlUrl) };
    }

    /**
     * Fetch and parse a CRL from a URL, with caching.
     */
    private async fetchCrl(url: string): Promise<CertificateList> {
        // Check cache first
        const cached = this.crlCache.get(url);
        if (cached && this.isCacheValid(cached)) {
            this.logger.debug(`Using cached CRL for ${url}`);
            return cached.crl;
        }

        this.logger.debug(`Fetching CRL from ${url}`);

        try {
            const response = await this.outboundUrlPolicy.getFollowingRedirects(
                url,
                {
                    timeoutMs: this.fetchTimeoutMs,
                    maxBytes: CRL_MAX_BYTES,
                    maxRedirects: CRL_MAX_REDIRECTS,
                    headers: {
                        accept: "application/pkix-crl, application/x-pkcs7-crl",
                    },
                    // CRL distribution points are plain HTTP by convention
                    // (RFC 5280, section 4.2.1.13), so HTTP is allowed
                    // regardless of OUTBOUND_URL_ALLOW_HTTP. Private addresses
                    // stay blocked unless OUTBOUND_URL_ALLOW_PRIVATE_NETWORK.
                    allowHttp: true,
                },
            );
            if (response.status < 200 || response.status >= 300) {
                throw new Error(
                    `Request failed with status code ${response.status}`,
                );
            }

            const crl = AsnParser.parse(response.bytes, CertificateList);

            // Extract nextUpdate for cache TTL
            let nextUpdate: Date | undefined;
            if (crl.tbsCertList.nextUpdate) {
                nextUpdate = crl.tbsCertList.nextUpdate.getTime();
            }

            // Cache the CRL
            this.crlCache.set(url, {
                crl,
                fetchedAt: Date.now(),
                nextUpdate: nextUpdate ? new Date(nextUpdate) : undefined,
            });

            return crl;
        } catch (error: any) {
            throw new Error(
                `Failed to fetch CRL from ${url}: ${error?.message || error}`,
            );
        }
    }

    /**
     * Check if a cached CRL is still valid.
     */
    private isCacheValid(cached: CachedCrl): boolean {
        const now = Date.now();

        // If CRL has nextUpdate, use that as the expiry
        if (cached.nextUpdate) {
            return now < cached.nextUpdate.getTime();
        }

        // Otherwise use default TTL
        return now - cached.fetchedAt < this.defaultCacheTtlMs;
    }

    /**
     * Convert ArrayBuffer to hex string.
     */
    private arrayBufferToHex(buffer: ArrayBuffer): string {
        return Array.from(new Uint8Array(buffer))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
    }

    /**
     * Parse CRL reason code.
     */
    private parseReasonCode(buffer: ArrayBuffer): string {
        const reasons = [
            "unspecified",
            "keyCompromise",
            "cACompromise",
            "affiliationChanged",
            "superseded",
            "cessationOfOperation",
            "certificateHold",
            "unused",
            "removeFromCRL",
            "privilegeWithdrawn",
            "aACompromise",
        ];

        try {
            const bytes = new Uint8Array(buffer);
            // Reason code is an ENUMERATED value, typically 3 bytes: 0x0a 0x01 <value>
            if (bytes.length >= 3 && bytes[0] === 0x0a && bytes[1] === 0x01) {
                const code = bytes[2];
                return reasons[code] || `unknown(${code})`;
            }
        } catch {
            // Ignore parsing errors
        }
        return "unknown";
    }

    /**
     * Clear the CRL cache.
     */
    clearCache(): void {
        this.crlCache.clear();
        this.logger.debug("CRL cache cleared");
    }

    /**
     * Get cache statistics.
     */
    getCacheStats(): { size: number; urls: string[] } {
        return {
            size: this.crlCache.size,
            urls: Array.from(this.crlCache.keys()),
        };
    }
}
