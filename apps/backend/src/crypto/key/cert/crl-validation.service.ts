import { Injectable, Logger } from "@nestjs/common";
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
    /** The parsed CRL, verified against its issuer when it was fetched */
    crl: x509.X509Crl;
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
 * - Verifies that a CRL is signed by the CA that issued the certificate
 * - Checks if certificates are revoked
 *
 * CRLs are usually served over plain HTTP, so a CRL counts only if its
 * issuer name matches the certificate's issuer and its signature verifies
 * with the issuing CA's key. A CRL that fails these checks is treated like
 * an unreachable one.
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
     * The CRL must be signed by the CA that issued the certificate. That CA
     * is looked up in `chainPems`: the certificate whose subject is the
     * certificate's issuer and whose key verifies the certificate's
     * signature. Without it, no CRL is fetched and the result is
     * inconclusive (`isValid: false` without `revokedAt`).
     *
     * A self-signed certificate is not checked: no CA could have revoked it.
     *
     * @param certPem - PEM-encoded certificate to check
     * @param chainPems - PEM-encoded certificates that may include the issuing CA
     * @returns CRL validation result
     */
    async checkCertificateRevocation(
        certPem: string,
        chainPems: string[] = [],
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

            if (await cert.isSelfSigned()) {
                this.logger.debug(
                    `Skipping CRL check for self-signed certificate ${cert.subject}`,
                );
                return {
                    isValid: true,
                    error: "Self-signed certificate; no CA to revoke it",
                };
            }

            const issuer = await this.findIssuer(cert, chainPems);
            if (!issuer) {
                this.logger.warn(
                    `Cannot check CRL for ${cert.subject}: the certificate of its issuer ${cert.issuer} is not in the chain`,
                );
                const noIssuerResult: CrlValidationResult = {
                    isValid: false,
                    error: `Issuer certificate not in the chain; cannot verify the CRL of ${cert.subject}`,
                };
                this.certValidationCache.set(cacheKey, {
                    result: noIssuerResult,
                    timestamp: Date.now(),
                });
                return noIssuerResult;
            }

            // Try each CRL URL until we get a successful check
            for (const url of crlUrls) {
                try {
                    const result = await this.checkAgainstCrl(
                        cert,
                        issuer,
                        url,
                    );
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
     * Find the certificate in `chainPems` that issued `cert`: its subject is
     * `cert`'s issuer and its key verifies `cert`'s signature.
     */
    private async findIssuer(
        cert: x509.X509Certificate,
        chainPems: string[],
    ): Promise<x509.X509Certificate | undefined> {
        for (const pem of chainPems) {
            let candidate: x509.X509Certificate;
            try {
                candidate = new x509.X509Certificate(pem);
            } catch {
                continue;
            }
            if (
                candidate.subject === cert.issuer &&
                (await cert.verify({
                    publicKey: candidate,
                    signatureOnly: true,
                }))
            ) {
                return candidate;
            }
        }
        return undefined;
    }

    /**
     * Check a certificate against a specific CRL URL.
     */
    private async checkAgainstCrl(
        cert: x509.X509Certificate,
        issuer: x509.X509Certificate,
        crlUrl: string,
    ): Promise<CrlValidationResult> {
        const { crl, fromCache } = await this.getVerifiedCrl(
            crlUrl,
            cert,
            issuer,
        );

        const revoked = crl.findRevoked(cert);
        if (!revoked) {
            return { isValid: true, fromCache };
        }

        return {
            isValid: false,
            revokedAt: revoked.revocationDate,
            reason:
                revoked.reason === undefined
                    ? undefined
                    : (x509.X509CrlReason[revoked.reason] ??
                      `unknown(${revoked.reason})`),
            fromCache,
        };
    }

    /**
     * Return the CRL at `url`, verified against the certificate's issuer.
     * Only verified CRLs are cached, so a forged response cannot displace
     * the CA's CRL for the lifetime it claims.
     */
    private async getVerifiedCrl(
        url: string,
        cert: x509.X509Certificate,
        issuer: x509.X509Certificate,
    ): Promise<{ crl: x509.X509Crl; fromCache: boolean }> {
        const cached = this.crlCache.get(url);
        if (cached && this.isCacheValid(cached)) {
            this.logger.debug(`Using cached CRL for ${url}`);
            // Another certificate may name the same URL with a different issuer.
            await this.verifyCrl(cached.crl, cert, issuer);
            return { crl: cached.crl, fromCache: true };
        }

        const crl = await this.fetchCrl(url);
        await this.verifyCrl(crl, cert, issuer);
        this.crlCache.set(url, {
            crl,
            fetchedAt: Date.now(),
            nextUpdate: crl.nextUpdate,
        });
        return { crl, fromCache: false };
    }

    /**
     * Throw unless `crl` was issued by `issuer` for certificates of `cert`'s
     * issuer (RFC 5280, section 6.3.3): matching issuer name, cRLSign key
     * usage if the issuer certificate restricts its key usage, and a
     * signature that verifies with the issuer's key.
     */
    private async verifyCrl(
        crl: x509.X509Crl,
        cert: x509.X509Certificate,
        issuer: x509.X509Certificate,
    ): Promise<void> {
        if (crl.issuer !== cert.issuer) {
            throw new Error(
                `CRL issuer "${crl.issuer}" does not match certificate issuer "${cert.issuer}"`,
            );
        }

        const keyUsage = issuer.getExtension(x509.KeyUsagesExtension);
        if (keyUsage && !(keyUsage.usages & x509.KeyUsageFlags.cRLSign)) {
            throw new Error(
                `Issuer certificate ${issuer.subject} lacks the cRLSign key usage`,
            );
        }

        if (!(await crl.verify({ publicKey: issuer.publicKey }))) {
            throw new Error(
                `CRL signature does not verify with the key of ${issuer.subject}`,
            );
        }
    }

    /**
     * Fetch and parse a CRL from a URL.
     */
    private async fetchCrl(url: string): Promise<x509.X509Crl> {
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

            return new x509.X509Crl(new Uint8Array(response.bytes));
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
