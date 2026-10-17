import { Injectable } from "@nestjs/common";
import * as x509 from "@peculiar/x509";
import { PinoLogger } from "nestjs-pino";
import { StatusListVerifierService } from "../../../trust/status-list-verifier.service.js";
import {
    BuiltTrustStore,
    TrustStoreService,
} from "../../../trust/trust-store.service.js";
import { TrustedEntity, TrustListSource } from "../../../trust/types.js";
import {
    MatchedTrustedEntity,
    X509ValidationService,
} from "../../../trust/x509-validation.service.js";

/**
 * Raised when a trust list WAS configured for a credential but could not be
 * turned into a usable trust store — the fetch/parse/signature check failed, or
 * the list is stale (its `NextUpdate` is in the past).
 *
 * This is deliberately distinct from "no trust list configured": the latter is a
 * legitimate opt-out (trust validation is opt-in per credential), whereas this
 * error means a requested security control is unavailable and verification MUST
 * fail closed rather than silently accept the credential.
 */
class TrustListUnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "TrustListUnavailableError";
    }
}

/**
 * Policy options for certificate chain validation.
 */
export interface ChainValidationPolicy {
    /** Whether to require x5c header in the credential */
    requireX5c?: boolean;
    /** How to match pinned certificates: "leaf" or "pathEnd" */
    pinnedCertMode?: "leaf" | "pathEnd";
    /** Service type filter for matching issuance certificates (default: "/Issuance") */
    serviceTypeFilter?: string;
    /** Whether to verify status list (revocation) */
    verifyStatusList?: boolean;
}

/**
 * Result of certificate chain validation.
 */
export interface ChainValidationResult {
    /** Whether the chain is valid */
    verified: boolean;
    /** The matched trusted entity (if any) */
    matchedEntity: MatchedTrustedEntity | null;
    /** Error message if validation failed */
    error?: string;
    /** Detailed error information for debugging */
    errorDetails?: string;
    /**
     * The validated path, leaf first, when the chain matched a trusted
     * entity of the trust list.
     */
    path?: x509.X509Certificate[];
}

/**
 * Shared service for certificate chain validation.
 * Used by both mDOC and SD-JWT-VC verifiers to ensure consistent behavior.
 *
 * Responsibilities:
 * - X.509 certificate chain building and validation
 * - Trust anchor matching against LoTE trust lists
 * - Status list (revocation) verification
 * - Detailed error reporting
 */
@Injectable()
export class CredentialChainValidationService {
    constructor(
        private readonly trustStore: TrustStoreService,
        private readonly x509v: X509ValidationService,
        private readonly statusListVerifier: StatusListVerifierService,
        private readonly logger: PinoLogger,
    ) {
        this.logger.setContext(CredentialChainValidationService.name);
    }

    /**
     * Validate a certificate chain against the trust store.
     *
     * @param x5c The x5c chain from the credential (base64 DER encoded)
     * @param trustListSource The trust list source configuration
     * @param policy Validation policy options
     * @returns Validation result with matched entity information
     */
    async validateChain(
        x5c: string[],
        trustListSource: TrustListSource | undefined,
        policy: ChainValidationPolicy = {},
    ): Promise<ChainValidationResult> {
        const {
            requireX5c = false,
            pinnedCertMode = "leaf",
            serviceTypeFilter = "/Issuance",
        } = policy;

        // 1) Check x5c requirement
        if (!x5c || x5c.length === 0) {
            if (requireX5c) {
                return {
                    verified: false,
                    matchedEntity: null,
                    error: "x5c_required",
                    errorDetails: "Policy requires x5c but none was provided",
                };
            }
            // No x5c and not required - skip trust validation
            return { verified: true, matchedEntity: null };
        }

        // 2) Parse the presented certificate chain
        let presented: x509.X509Certificate[];
        try {
            presented = this.x509v.parseX5c(x5c);
        } catch (e: any) {
            return {
                verified: false,
                matchedEntity: null,
                error: "invalid_x5c",
                errorDetails: `Failed to parse x5c chain: ${e?.message ?? e}`,
            };
        }

        const leaf = presented[0];

        // 3) Load trust store for LoTE-based validation.
        // A configured-but-unavailable trust list (fetch/parse/signature failure
        // or stale list) MUST fail closed — never accept a credential when a
        // requested trust list cannot be evaluated.
        let store: BuiltTrustStore | null;
        try {
            store = await this.getTrustStoreIfConfigured(trustListSource);
        } catch (error) {
            if (error instanceof TrustListUnavailableError) {
                return {
                    verified: false,
                    matchedEntity: null,
                    error: "trust_list_unavailable",
                    errorDetails: error.message,
                };
            }
            throw error;
        }
        if (!store) {
            // No trust list configured - preserve existing behavior
            this.logger.debug(
                "No trust list source configured, returning verified without LoTE trust validation",
            );
            return { verified: true, matchedEntity: null };
        }

        // 4) Get all certificates from entities for path building
        const allCerts = store.entities.flatMap((e) =>
            e.services.map((s) => ({ certValue: s.certValue })),
        );
        const anchors = this.x509v.parseTrustAnchors(allCerts);

        // 5) Build the certificate path
        let path: x509.X509Certificate[];
        try {
            path = await this.x509v.buildPath(leaf, presented, anchors, []);
        } catch (e: any) {
            const errorDetails = await this.buildChainErrorDetails(
                presented,
                store,
                trustListSource,
                e,
            );

            return {
                verified: false,
                matchedEntity: null,
                error: "chain_build_failed",
                errorDetails,
            };
        }

        await this.logChainKeyIdentifiers(path, anchors);

        // 6) Check time validity
        const now = new Date();
        for (const cert of path) {
            if (!this.x509v.isTimeValid(cert, now)) {
                return {
                    verified: false,
                    matchedEntity: null,
                    error: "certificate_expired",
                    errorDetails: `Certificate expired or not yet valid: subject="${cert.subject}", notBefore=${cert.notBefore.toISOString()}, notAfter=${cert.notAfter.toISOString()}`,
                };
            }
        }

        // 7) Match against TrustedEntities
        const matchedEntity = await this.x509v.pathMatchesTrustedEntities(
            path,
            store.entities,
            pinnedCertMode,
            serviceTypeFilter,
        );

        if (!matchedEntity) {
            const errorDetails = await this.buildNoMatchErrorDetails(
                path,
                store,
                trustListSource,
                pinnedCertMode,
            );

            return {
                verified: false,
                matchedEntity: null,
                error: "no_trusted_entity_match",
                errorDetails,
            };
        }

        this.logger.debug(
            `Certificate chain validated successfully. Matched entity: ${matchedEntity.entity.entityId ?? "unknown"}, mode: ${matchedEntity.matchMode}`,
        );

        return { verified: true, matchedEntity, path };
    }

    /**
     * Verify a status list JWT signature against the matched entity's
     * revocation certificate, or its matched issuance certificate if the
     * entity lists no revocation service.
     *
     * @param statusListJwt The status list JWT
     * @param matchedEntity The matched trusted entity (may be null)
     * @param trustListSource Trust list source for chain building
     * @param policy Validation policy
     * @returns true if status list is valid
     */
    async verifyStatusListSignature(
        x5c: string[] | undefined,
        matchedEntity: MatchedTrustedEntity | null,
        trustListSource: TrustListSource | undefined,
        policy: ChainValidationPolicy = {},
    ): Promise<boolean> {
        // If no entity was matched (no x5c in original credential), accept
        if (!matchedEntity) {
            return true;
        }

        if (!x5c?.length) {
            this.logger.warn(
                "Status list JWT missing x5c, but credential had x5c trust chain",
            );
            return false;
        }

        // The status list must be signed under a revocation certificate of
        // the entity that issued the credential, or, if the entity lists no
        // revocation service, under the certificate the credential matched.
        // Any other signer could serve a list in which a revoked credential
        // is valid. Entities are told apart by certificate, not by entityId,
        // which is an optional and not necessarily unique name.
        const entityId = matchedEntity.entity.entityId ?? "unknown";
        const revocationServices = matchedEntity.entity.services.filter((s) =>
            s.serviceTypeIdentifier.endsWith("/Revocation"),
        );
        const result = await this.validateChain(x5c, trustListSource, {
            ...policy,
            serviceTypeFilter:
                revocationServices.length > 0 ? "/Revocation" : "/Issuance",
        });
        if (!result.verified || !result.path) {
            this.logger.warn(
                `Status list chain validation failed for TrustedEntity ${entityId}: ${result.errorDetails ?? "no trusted entity matched"}`,
            );
            return false;
        }

        const leafThumb = await this.getThumbprint(result.path[0]);
        const endThumb = await this.getThumbprint(result.path.at(-1)!);

        if (revocationServices.length === 0) {
            // CA or path end match: the path ends at the issuance
            // certificate. Leaf pin: the leaf is that certificate.
            const signerThumb =
                matchedEntity.matchMode === "leaf-pinned"
                    ? leafThumb
                    : endThumb;
            if (signerThumb !== matchedEntity.issuanceThumbprint) {
                this.logger.warn(
                    `Status list is not signed under the issuance certificate of TrustedEntity ${entityId}, which has no revocation certificate. Expected: ${matchedEntity.issuanceThumbprint}, status list: ${signerThumb}`,
                );
                return false;
            }
            return true;
        }

        // Same rule as for credentials: a CA revocation certificate must be
        // the path end, a pinned one the leaf or path end per pinnedCertMode.
        const revocationMatch = await this.x509v.pathMatchesTrustedEntities(
            result.path,
            [matchedEntity.entity],
            policy.pinnedCertMode ?? "leaf",
            "/Revocation",
        );
        if (revocationMatch) {
            return true;
        }

        this.logger.warn(
            `Status list is not signed under a revocation certificate of TrustedEntity ${entityId}. Status list leaf: ${leafThumb}, path end: ${endThumb}`,
        );
        return false;
    }

    /**
     * Fetch a status list JWT with caching.
     * Delegates to StatusListVerifierService.
     */
    async fetchStatusListJwt(uri: string): Promise<string> {
        return this.statusListVerifier.getStatusListJwt(uri);
    }

    /**
     * Get trusted certificate buffers for mDOC verification.
     * Returns certificates as Uint8Array[] for the mdoc library.
     */
    async getTrustedCertificateBuffers(
        trustListSource?: TrustListSource,
    ): Promise<Uint8Array[]> {
        const store = await this.getTrustStoreForAugmentation(trustListSource);
        if (!store) {
            return [];
        }

        const trustedCertificates: Uint8Array[] = [];

        for (const entity of store.entities) {
            const issuanceServices = entity.services.filter((s) =>
                s.serviceTypeIdentifier.endsWith("/Issuance"),
            );

            for (const svc of issuanceServices) {
                try {
                    const cert = new x509.X509Certificate(svc.certValue as any);
                    trustedCertificates.push(new Uint8Array(cert.rawData));
                } catch (e: any) {
                    this.logger.warn(
                        `Failed to parse certificate from entity ${entity.entityId}: ${e?.message ?? e}`,
                    );
                }
            }
        }

        this.logger.debug(
            `Loaded ${trustedCertificates.length} trusted certificate(s) for verification`,
        );

        return trustedCertificates;
    }

    /**
     * Get trusted revocation certificate buffers for mDOC status validation.
     * Returns certificates as Uint8Array[] for the mdoc library.
     */
    async getTrustedStatusCertificateBuffers(
        trustListSource?: TrustListSource,
    ): Promise<Uint8Array[]> {
        const store = await this.getTrustStoreForAugmentation(trustListSource);
        if (!store) {
            return [];
        }

        const trustedCertificates: Uint8Array[] = [];

        for (const entity of store.entities) {
            const revocationServices = entity.services.filter((s) =>
                s.serviceTypeIdentifier.endsWith("/Revocation"),
            );

            for (const svc of revocationServices) {
                try {
                    const cert = new x509.X509Certificate(svc.certValue as any);
                    trustedCertificates.push(new Uint8Array(cert.rawData));
                } catch (e: any) {
                    this.logger.warn(
                        `Failed to parse revocation certificate from entity ${entity.entityId}: ${e?.message ?? e}`,
                    );
                }
            }
        }

        this.logger.debug(
            `Loaded ${trustedCertificates.length} trusted status certificate(s) for verification`,
        );

        return trustedCertificates;
    }

    /**
     * Load the configured trust store.
     *
     * Returns `null` ONLY when no trust list is configured for the credential
     * (legitimate opt-out). When a trust list IS configured but cannot be turned
     * into a usable store — the fetch/parse/signature check fails, or the list is
     * stale ({@link BuiltTrustStore.nextUpdate} in the past) — it throws
     * {@link TrustListUnavailableError} so callers can fail closed instead of
     * silently accepting the credential.
     */
    /**
     * Best-effort trust store load for NON-authoritative anchor augmentation
     * (supplying extra certificates to the mDOC signature check).
     *
     * Unlike {@link getTrustStoreIfConfigured}, an unavailable/stale trust list is
     * swallowed to `null` here: the authoritative trust decision is made by
     * {@link validateChain}, which fails closed on {@link TrustListUnavailableError}.
     * Returning no extra anchors from this path is therefore safe.
     */
    private async getTrustStoreForAugmentation(
        trustListSource?: TrustListSource,
    ): Promise<BuiltTrustStore | null> {
        try {
            return await this.getTrustStoreIfConfigured(trustListSource);
        } catch (error) {
            if (error instanceof TrustListUnavailableError) {
                return null;
            }
            throw error;
        }
    }

    private async getTrustStoreIfConfigured(
        trustListSource?: TrustListSource,
    ): Promise<BuiltTrustStore | null> {
        if (!trustListSource?.lotes?.length) {
            return null;
        }

        let store: BuiltTrustStore;
        try {
            store = await this.trustStore.getTrustStore(trustListSource);
        } catch (error: any) {
            const message = `Failed to load configured trust store: ${error?.message ?? error}`;
            this.logger.error(message);
            throw new TrustListUnavailableError(message);
        }

        if (store.nextUpdate) {
            const nu = new Date(store.nextUpdate);
            if (!Number.isNaN(nu.getTime()) && nu.getTime() < Date.now()) {
                const message = `Configured trust list is stale (NextUpdate in the past: ${store.nextUpdate})`;
                this.logger.warn(message);
                throw new TrustListUnavailableError(message);
            }
        }

        return store;
    }

    /**
     * Build detailed error information when chain building fails.
     */
    private async buildChainErrorDetails(
        presented: x509.X509Certificate[],
        store: BuiltTrustStore,
        trustListSource: TrustListSource | undefined,
        error: any,
    ): Promise<string> {
        const leaf = presented[0];
        const leafThumb = await this.getThumbprint(leaf);

        const configuredTrustLists =
            trustListSource?.lotes?.map((l) => l.url).join(", ") ||
            "none configured";

        const trustedCertsSummary = await this.summarizeTrustedCerts(
            store.entities,
        );

        return [
            `Error: ${error?.message ?? error}`,
            `Presented leaf: subject="${leaf.subject}", issuer="${leaf.issuer}", thumbprint=${leafThumb}`,
            `Presented chain length: ${presented.length}`,
            `Configured trust lists: ${configuredTrustLists}`,
            `Trusted entities (${store.entities.length}): ${trustedCertsSummary}`,
        ].join(" | ");
    }

    /**
     * Build detailed error information when no trusted entity matches.
     */
    private async buildNoMatchErrorDetails(
        path: x509.X509Certificate[],
        store: BuiltTrustStore,
        trustListSource: TrustListSource | undefined,
        pinnedMode: string,
    ): Promise<string> {
        const leaf = path[0];
        const end = path.at(-1)!;
        const leafThumb = await this.getThumbprint(leaf);
        const endThumb = await this.getThumbprint(end);

        const configuredTrustLists =
            trustListSource?.lotes?.map((l) => l.url).join(", ") ||
            "none configured";

        const trustedCertsSummary = await this.summarizeTrustedCerts(
            store.entities,
        );

        // Collect thumbprints of allowed certificates
        const allowedThumbprints: string[] = [];
        for (const entity of store.entities) {
            for (const svc of entity.services) {
                if (svc.serviceTypeIdentifier.endsWith("/Issuance")) {
                    try {
                        const cert = new x509.X509Certificate(
                            svc.certValue as any,
                        );
                        const thumb = await this.getThumbprint(cert);
                        allowedThumbprints.push(
                            `${cert.subject} (${thumb.substring(0, 16)}...)`,
                        );
                    } catch {
                        // Skip invalid certs
                    }
                }
            }
        }

        return [
            `Presented leaf: subject="${leaf.subject}", issuer="${leaf.issuer}", thumbprint=${leafThumb}`,
            `Presented path end: subject="${end.subject}", thumbprint=${endThumb}`,
            `Pinned mode: ${pinnedMode}`,
            `Path length: ${path.length}`,
            `Configured trust lists: ${configuredTrustLists}`,
            `Loaded entities (${store.entities.length}): ${trustedCertsSummary}`,
            `Allowed cert thumbprints: ${allowedThumbprints.length > 0 ? allowedThumbprints.join("; ") : "none"}`,
        ].join(" | ");
    }

    /**
     * Summarize trusted entities for error logging.
     */
    private async summarizeTrustedCerts(
        entities: TrustedEntity[],
    ): Promise<string> {
        const summaries: string[] = [];
        for (const entity of entities.slice(0, 5)) {
            const issuanceSvcs = entity.services.filter((s) =>
                s.serviceTypeIdentifier.endsWith("/Issuance"),
            );
            summaries.push(
                `${entity.entityId ?? "unknown"} (${issuanceSvcs.length} issuance cert(s))`,
            );
        }
        if (entities.length > 5) {
            summaries.push(`...and ${entities.length - 5} more`);
        }
        return summaries.length > 0 ? summaries.join("; ") : "none";
    }

    /**
     * Get hex thumbprint of a certificate.
     */
    private async getThumbprint(cert: x509.X509Certificate): Promise<string> {
        const buffer = await cert.getThumbprint("SHA-256");
        return Array.from(new Uint8Array(buffer))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
    }

    private extractExtensionKeyId(
        extension: { keyId?: string } | undefined,
    ): string | undefined {
        const keyId = extension?.keyId;
        return typeof keyId === "string" && keyId.length > 0
            ? keyId.toLowerCase()
            : undefined;
    }

    private async logChainKeyIdentifiers(
        path: x509.X509Certificate[],
        anchors: x509.X509Certificate[],
    ): Promise<void> {
        const mapCert = async (cert: x509.X509Certificate) => ({
            subject: cert.subject,
            issuer: cert.issuer,
            thumbprint: await this.getThumbprint(cert),
            ski: this.extractExtensionKeyId(
                cert.getExtension("2.5.29.14") as any,
            ),
            aki: this.extractExtensionKeyId(
                cert.getExtension("2.5.29.35") as any,
            ),
        });

        const pathCerts = await Promise.all(path.map((cert) => mapCert(cert)));
        const rootOfTrust = path.at(-1)
            ? await mapCert(path.at(-1)!)
            : undefined;

        this.logger.debug(
            {
                rootOfTrust,
                validatedPath: pathCerts,
            },
            "X.509 chain identifiers (SKI/AKI) for trust matching",
        );
    }
}
