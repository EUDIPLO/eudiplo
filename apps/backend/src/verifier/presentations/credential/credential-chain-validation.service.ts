import { Injectable } from "@nestjs/common";
import * as x509 from "@peculiar/x509";
import { PinoLogger } from "nestjs-pino";
import { CertificateChainTooLong } from "../../../shared/utils/certificate-chain-length.util.js";
import { getRevocationServices } from "../../../trust/domain/status-list-signers.js";
import { describeDiscardedTrustLists } from "../../../trust/domain/trust-list-freshness.js";
import {
    BuiltTrustStore,
    TrustStoreService,
} from "../../../trust/trust-store.service.js";
import {
    credentialIssuerServiceTypes,
    isCredentialIssuerServiceType,
    ServiceTypeIdentifiers,
    TrustedEntity,
    TrustListSource,
} from "../../../trust/types.js";
import {
    MatchedTrustedEntity,
    ServiceTypeFilter,
    X509ValidationService,
} from "../../../trust/x509-validation.service.js";

/**
 * Raised when a trust list WAS configured for a credential but could not be
 * turned into a usable trust store — the fetch/parse/signature check failed, or
 * every one of its lists is past its `NextUpdate`.
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
 * Error-detail line naming the lists left out of the store as outdated, so an
 * operator can tell a lapsed list from an issuer that is not listed.
 */
function discardedDetail(store: BuiltTrustStore): string[] {
    return store.discarded.length > 0
        ? [
              `Discarded outdated trust lists (their issuers are not trusted): ${describeDiscardedTrustLists(store.discarded)}`,
          ]
        : [];
}

/**
 * Policy options for certificate chain validation.
 */
export interface ChainValidationPolicy {
    /** Whether to require x5c header in the credential */
    requireX5c?: boolean;
    /** How to match pinned certificates: "leaf" or "pathEnd" */
    pinnedCertMode?: "leaf" | "pathEnd";
    /** Whether to verify status list (revocation) */
    verifyStatusList?: boolean;
}

/**
 * A trust anchor entry of the mdoc library: issuance certificates and the
 * certificates the status lists of credentials issued under them must be
 * signed under.
 */
export interface MdocTrustedCertificates {
    issuance: Uint8Array[];
    status: Uint8Array[];
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
    /**
     * Whether the path matches a PID issuance service of the trust lists,
     * also when `matchedEntity` is another service the same certificate is
     * listed with. A credential under it counts as a PID.
     */
    pidIssuer?: boolean;
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
        private readonly logger: PinoLogger,
    ) {
        this.logger.setContext(CredentialChainValidationService.name);
    }

    /**
     * Validate a certificate chain against the trust store. The chain must
     * match a service of {@link credentialIssuerServiceTypes}, compared
     * exactly: a PID, Pub-EAA or EAA issuance service, never, for example,
     * the `WalletSolution/Issuance` service of the same entity.
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
        return this.validateChainPreferring(
            x5c,
            trustListSource,
            policy,
            credentialIssuerServiceTypes,
            [],
        );
    }

    /**
     * {@link validateChain} against the services of `serviceTypeFilter`,
     * trying `preferredAnchors` as path anchors before all other trust-list
     * certificates. The status list check uses it with the status list
     * signers of the entity the status list must belong to.
     */
    private async validateChainPreferring(
        x5c: string[],
        trustListSource: TrustListSource | undefined,
        policy: ChainValidationPolicy,
        serviceTypeFilter: ServiceTypeFilter,
        preferredAnchors: Array<{ certValue: string }>,
    ): Promise<ChainValidationResult> {
        const { requireX5c = false, pinnedCertMode = "leaf" } = policy;

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

        // 2) Parse the presented certificate chain, refusing one longer than
        // MAX_CERTIFICATE_CHAIN_LENGTH, also when no trust list is configured
        let presented: x509.X509Certificate[];
        try {
            presented = this.x509v.parseX5c(x5c);
        } catch (e: any) {
            return {
                verified: false,
                matchedEntity: null,
                error: "invalid_x5c",
                errorDetails:
                    e instanceof CertificateChainTooLong
                        ? e.message
                        : `Failed to parse x5c chain: ${e?.message ?? e}`,
            };
        }

        const leaf = presented[0];

        // 3) Load trust store for LoTE-based validation.
        // A configured-but-unavailable trust list (fetch/parse/signature failure,
        // or every list outdated) MUST fail closed — never accept a credential
        // when a requested trust list cannot be evaluated. Outdated lists next
        // to current ones are left out of the store and add no trust.
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

        // 4) Get all certificates from entities for path building: the
        // preferred ones first, then those of the requested service type, so
        // that the path ends at the anchor being checked when anchors share
        // subject and key.
        const anchors = this.x509v.parseTrustAnchors([
            ...preferredAnchors,
            ...this.x509v.anchorCertValuesFor(
                store.entities,
                serviceTypeFilter,
            ),
        ]);

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
                serviceTypeFilter,
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

        // The first matching service decides the status list signers; a
        // certificate listed as PID and as EAA issuer still issues PIDs.
        const pidIssuer =
            matchedEntity.issuanceServiceType ===
                ServiceTypeIdentifiers.PIDIssuance ||
            (serviceTypeFilter.includes(ServiceTypeIdentifiers.PIDIssuance) &&
                (await this.leadsToPidIssuer(
                    leaf,
                    presented,
                    store,
                    pinnedCertMode,
                )));

        return { verified: true, matchedEntity, path, pidIssuer };
    }

    /**
     * Whether `leaf` also chains to a certificate listed with a PID issuance
     * service. The path is built again with those certificates first in the
     * pool, ahead of the presented ones: two certificates can share subject
     * and key, for example a CA listed once as EAA and once as PID issuer,
     * and the path built for the match could end at the EAA copy, also one
     * the wallet put in an mDOC's unprotected `x5chain`. The chain is
     * already trusted; this only classifies the issuer, so a PID-listed
     * certificate counts also outside its validity period.
     */
    private async leadsToPidIssuer(
        leaf: x509.X509Certificate,
        presented: x509.X509Certificate[],
        store: BuiltTrustStore,
        pinnedCertMode: "leaf" | "pathEnd",
    ): Promise<boolean> {
        const pidTypes = [ServiceTypeIdentifiers.PIDIssuance];
        // Only PID services whose certificate parses: one that does not can
        // end no path, and matching it would throw and reject a credential
        // that already matched another service.
        const pidEntities = store.entities.map((entity) => ({
            ...entity,
            services: entity.services.filter(
                (service) =>
                    service.serviceTypeIdentifier ===
                        ServiceTypeIdentifiers.PIDIssuance &&
                    this.x509v.parseTrustAnchors([service]).length === 1,
            ),
        }));
        const pidCertificates = this.x509v.parseTrustAnchors(
            pidEntities.flatMap((entity) => entity.services),
        );
        if (pidCertificates.length === 0) {
            return false;
        }
        let path: x509.X509Certificate[];
        try {
            path = await this.x509v.buildPath(
                leaf,
                [],
                [...pidCertificates, ...presented],
            );
        } catch (error) {
            this.logger.debug(
                `No path to a PID issuance certificate: ${error instanceof Error ? error.message : String(error)}`,
            );
            return false;
        }
        return (
            (await this.x509v.pathMatchesTrustedEntities(
                path,
                pidEntities,
                pinnedCertMode,
                pidTypes,
            )) !== null
        );
    }

    /**
     * Verify a status list JWT signature against the revocation certificates
     * paired with the matched issuance service, or the matched issuance
     * certificate if the entity lists no such revocation service
     * (`getStatusListSigners` in `trust/domain/status-list-signers.ts`).
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
        // the entity that issued the credential, of the type paired with the
        // matched issuance service (PID/Revocation for PID/Issuance), or, if
        // the entity lists none, under the certificate the credential
        // matched. Any other signer could serve a list in which a revoked
        // credential is valid.
        const entityId = matchedEntity.entity.entityId ?? "unknown";
        const signers = this.x509v.statusListSigners(matchedEntity);
        const signerTypes = [
            ...new Set(signers.map((s) => s.serviceTypeIdentifier)),
        ];
        // The status list must chain to these certificates; try them before
        // same-subject anchors of other entities.
        const result = await this.validateChainPreferring(
            x5c,
            trustListSource,
            policy,
            signerTypes,
            signers.map((s) => ({ certValue: s.certValue })),
        );
        if (!result.verified || !result.path) {
            this.logger.warn(
                `Status list chain validation failed for TrustedEntity ${entityId}: ${result.errorDetails ?? "no trusted entity matched"}`,
            );
            return false;
        }

        // Same rule as for credentials: a CA certificate must be the path
        // end, a pinned one the leaf or path end per pinnedCertMode.
        if (
            await this.x509v.matchesStatusListSigner(
                result.path,
                matchedEntity,
                policy.pinnedCertMode ?? "leaf",
            )
        ) {
            return true;
        }

        const leafThumb = await this.getThumbprint(result.path[0]);
        const endThumb = await this.getThumbprint(result.path.at(-1)!);
        this.logger.warn(
            `Status list is not signed under a ${signerTypes.join(" or ")} certificate of TrustedEntity ${entityId} matched with ${matchedEntity.issuanceServiceType}. Status list leaf: ${leafThumb}, path end: ${endThumb}`,
        );
        return false;
    }

    /**
     * Trust anchors for the mdoc library, one per credential issuer service
     * ({@link credentialIssuerServiceTypes}) of the trust list: its
     * certificate as `issuance`, and the certificates its status lists must
     * be signed under (`getStatusListSigners`) as `status`. The mdoc
     * library checks a status list against the `status` certificates of the
     * entry whose `issuance` certificate the credential chain ended at, so a
     * status list signer of another service or entity is not accepted.
     */
    async getTrustedCertificateEntries(
        trustListSource?: TrustListSource,
    ): Promise<MdocTrustedCertificates[]> {
        const store = await this.getTrustStoreForAugmentation(trustListSource);
        if (!store) {
            return [];
        }

        const entries = store.entities.flatMap((entity) =>
            this.mdocEntriesOf(entity),
        );

        this.logger.debug(
            `Loaded ${entries.length} trusted issuance certificate(s) for verification`,
        );

        return entries;
    }

    /**
     * The mdoc trust anchor entries of one entity, see
     * {@link getTrustedCertificateEntries}. A list may repeat certificates
     * and services: each certificate is parsed once, and the entries of a
     * service type share one status array, since their paired revocation
     * services are the same. Otherwise the work grows with issuance times
     * revocation services.
     */
    private mdocEntriesOf(entity: TrustedEntity): MdocTrustedCertificates[] {
        const parsed = new Map<string, Uint8Array | undefined>();
        const parse = (certValue: string) => {
            if (!parsed.has(certValue)) {
                parsed.set(certValue, this.parseCertificate(certValue, entity));
            }
            return parsed.get(certValue);
        };
        // Per service type: the paired revocation certificates, or null
        // when the entity lists none (see getStatusListSigners).
        const revocationByType = new Map<string, Uint8Array[] | null>();
        const revocationOf = (type: string) => {
            if (!revocationByType.has(type)) {
                const services = getRevocationServices(entity, type);
                revocationByType.set(
                    type,
                    services.length > 0
                        ? services
                              .map((signer) => parse(signer.certValue))
                              .filter((cert) => cert !== undefined)
                        : null,
                );
            }
            return revocationByType.get(type) ?? null;
        };

        const entries: MdocTrustedCertificates[] = [];
        for (const svc of entity.services) {
            const type = svc.serviceTypeIdentifier;
            if (!isCredentialIssuerServiceType(type)) continue;
            const issuance = parse(svc.certValue);
            if (!issuance) continue;
            // An entity without paired revocation services signs status
            // lists under the matched certificate. Paired ones that do not
            // parse leave no signer: the status check then fails.
            const status = revocationOf(type) ?? [issuance];
            entries.push({ issuance: [issuance], status });
        }
        return entries;
    }

    /** DER bytes of a trust-list certificate, or nothing if it does not parse. */
    private parseCertificate(
        certValue: string,
        entity: TrustedEntity,
    ): Uint8Array | undefined {
        try {
            const cert = new x509.X509Certificate(certValue as any);
            return new Uint8Array(cert.rawData);
        } catch (e: any) {
            this.logger.warn(
                `Failed to parse certificate from entity ${entity.entityId}: ${e?.message ?? e}`,
            );
            return undefined;
        }
    }

    /**
     * Names the configured lists left out as outdated, for verifiers whose
     * trust failure does not go through {@link validateChain} (mDOC checks
     * its anchors itself). Undefined when none was left out.
     */
    async discardedTrustListsDetail(
        trustListSource?: TrustListSource,
    ): Promise<string | undefined> {
        const store = await this.getTrustStoreForAugmentation(trustListSource);
        return store ? discardedDetail(store)[0] : undefined;
    }

    /**
     * Best-effort trust store load for NON-authoritative anchor augmentation
     * (supplying extra certificates to the mDOC signature check).
     *
     * Unlike {@link getTrustStoreIfConfigured}, an unavailable trust list, or
     * one whose lists are all outdated, is swallowed to `null` here: the
     * authoritative trust decision is made by {@link validateChain}, which
     * fails closed on {@link TrustListUnavailableError}. Returning no extra
     * anchors from this path is therefore safe.
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

    /**
     * Load the configured trust store.
     *
     * Returns `null` ONLY when no trust list is configured for the credential
     * (legitimate opt-out). When a trust list IS configured but cannot be turned
     * into a usable store — the fetch/parse/signature check fails, or every
     * one of its lists is past its `NextUpdate` — it throws
     * {@link TrustListUnavailableError} so callers can fail closed instead of
     * silently accepting the credential.
     */
    private async getTrustStoreIfConfigured(
        trustListSource?: TrustListSource,
    ): Promise<BuiltTrustStore | null> {
        if (!trustListSource?.lotes?.length) {
            return null;
        }

        try {
            return await this.trustStore.getTrustStore(trustListSource);
        } catch (error: any) {
            const message = `Failed to load configured trust store: ${error?.message ?? error}`;
            this.logger.error(message);
            throw new TrustListUnavailableError(message);
        }
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
            ...discardedDetail(store),
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
        serviceTypeFilter: ServiceTypeFilter,
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
                if (serviceTypeFilter.includes(svc.serviceTypeIdentifier)) {
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
            ...discardedDetail(store),
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
                isCredentialIssuerServiceType(s.serviceTypeIdentifier),
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
