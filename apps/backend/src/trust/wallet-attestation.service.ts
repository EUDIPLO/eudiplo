import { X509Certificate } from "node:crypto";
import {
    Inject,
    Injectable,
    Logger,
    UnauthorizedException,
} from "@nestjs/common";
import { Openid4vciIssuer } from "@openid4vc/openid4vci";
import type { StatusListEntry } from "@owf/token-status-list";
import * as x509 from "@peculiar/x509";
import { decodeProtectedHeader, JWK } from "jose";
import { Span } from "nestjs-otel";
import { CryptoService } from "../crypto/crypto.service.js";
import { CryptoImplementationService } from "../crypto/key/crypto-implementation/crypto-implementation.service.js";
import { TrustListRef } from "../verifier/presentations/entities/presentation-config.entity.js";
import { AttestationCertificateNotValid } from "./domain/attestation-certificate-validity.js";
import { AttestationStatusRejected } from "./domain/attestation-status-rejected.js";
import {
    discardedTrustListsNote,
    walletSafeTrustFailure,
} from "./domain/trust-list-freshness.js";
import {
    RevocationListUnavailableError,
    revocationModeToPolicy,
} from "./revocation-policy.util.js";
import {
    StatusCheckResult,
    StatusListIndexOutOfRange,
    StatusListVerifierService,
} from "./status-list-verifier.service.js";
import { BuiltTrustStore, TrustStoreService } from "./trust-store.service.js";
import {
    normalizeTrustListRefs,
    RevocationCheckMode,
    TrustListSource,
    walletSolutionServiceTypes,
} from "./types.js";
import {
    WALLET_ATTESTATION_SETTINGS,
    type WalletAttestationSettings,
} from "./wallet-attestation-settings.js";
import {
    MatchedTrustedEntity,
    X509ValidationService,
} from "./x509-validation.service.js";

/** How status check messages name the attestation. */
type AttestationLabel = "Wallet attestation" | "Key attestation";

export interface ClientAttestation {
    clientAttestationJwt: string;
    clientAttestationPopJwt?: string;
}

/** Answer when the wallet-provider trust lists cannot be loaded. */
const WALLET_PROVIDER_TRUST_LISTS_UNAVAILABLE =
    "Wallet provider trust lists could not be loaded";

/**
 * Service for verifying wallet attestations.
 * Handles validation of client attestation JWTs, X.509 certificate chains,
 * and status list verification for wallet providers.
 */
@Injectable()
export class WalletAttestationService {
    private readonly logger = new Logger(WalletAttestationService.name);

    constructor(
        private readonly cryptoService: CryptoService,
        private readonly cryptoImplementationService: CryptoImplementationService,
        private readonly trustStoreService: TrustStoreService,
        private readonly x509ValidationService: X509ValidationService,
        private readonly statusListVerifierService: StatusListVerifierService,
        @Inject(WALLET_ATTESTATION_SETTINGS)
        private readonly settings: WalletAttestationSettings,
    ) {}

    /**
     * Get the OID4VCI issuer instance for a specific tenant.
     * Used for wallet attestation verification.
     * @param tenantId The ID of the tenant.
     * @returns The OID4VCI issuer instance.
     */
    private getIssuer(tenantId: string, sessionId?: string): Openid4vciIssuer {
        const callbacks = this.cryptoService.getCallbackContext(
            tenantId,
            sessionId,
        );
        return new Openid4vciIssuer({
            callbacks,
        });
    }

    /**
     * Verify wallet attestation if provided or required.
     * Validates the attestation JWT signature, checks the X.509 certificate chain
     * against configured trust lists, and verifies the status list if present.
     * @param tenantId The tenant ID
     * @param clientAttestation The client attestation from the request
     * @param authorizationServer The authorization server URL
     * @param walletAttestationRequired Whether wallet attestation is required
     * @param walletProviderTrustLists Trust lists containing trusted wallet providers
     * @param statusCheckMode How to handle the attestation's status list:
     * strict rejects on any status check failure, best_effort accepts when the
     * list cannot be fetched, disabled skips the check
     * @throws UnauthorizedException if attestation is required but not provided, or if provided but invalid;
     * message and cause as the `ClientAttestationVerifier` port describes
     */
    @Span("walletAttestation.verify")
    async verifyWalletAttestation(
        tenantId: string,
        clientAttestation: ClientAttestation | undefined,
        authorizationServer: string,
        walletAttestationRequired: boolean,
        walletProviderTrustLists: TrustListRef[],
        statusCheckMode: RevocationCheckMode,
    ): Promise<void> {
        if (!clientAttestation) {
            if (walletAttestationRequired) {
                throw new UnauthorizedException(
                    "Wallet attestation is required but not provided",
                );
            }
            return;
        }

        try {
            const issuer = this.getIssuer(tenantId);
            // First verify the attestation JWT structure and PoP. The reason
            // is about what the wallet sent (format, signature, audience,
            // expiry), so it stays in the answer.
            try {
                await issuer.verifyWalletAttestation({
                    authorizationServer,
                    clientAttestationJwt:
                        clientAttestation.clientAttestationJwt,
                    clientAttestationPopJwt:
                        clientAttestation.clientAttestationPopJwt!,
                    allowedSkewInSeconds: this.settings.cryptoToleranceSeconds,
                });
            } catch (err) {
                throw new UnauthorizedException(
                    `Wallet attestation verification failed: ${err instanceof Error ? err.message : "Unknown error"}`,
                    { cause: err instanceof Error ? err : undefined },
                );
            }

            // Then validate the X.509 certificate against trust lists and get the matched entity
            const { matchedEntity, trustStore } =
                await this.validateWalletSolutionCertificate(
                    clientAttestation.clientAttestationJwt,
                    walletProviderTrustLists,
                    tenantId,
                );

            // Check the status list if present in the attestation JWT
            // Pass the matched entity and trust store for signature verification
            await this.validateAttestationStatus(
                tenantId,
                clientAttestation.clientAttestationJwt,
                matchedEntity,
                trustStore,
                statusCheckMode,
            );

            this.logger.debug("Wallet attestation verified successfully");
        } catch (err) {
            if (err instanceof UnauthorizedException) {
                throw err;
            }
            // Any other error comes from the server side, not from what the
            // wallet sent: fixed message, reason as cause.
            throw new UnauthorizedException(
                "Wallet attestation verification failed",
                { cause: err instanceof Error ? err : undefined },
            );
        }
    }

    /**
     * Fetch and verify the wallet-provider trust lists of a source.
     * @throws UnauthorizedException when every list is outdated, with the
     * message of {@link OutdatedTrustListsError}, which names no list
     * @throws UnauthorizedException with a fixed message when a list cannot
     * be fetched, read or verified; the reason, which names the list URL (for
     * a managed list one built from `INTERNAL_URL`), is the cause
     */
    private async loadTrustStore(
        source: TrustListSource,
    ): Promise<BuiltTrustStore> {
        try {
            return await this.trustStoreService.getTrustStore(source);
        } catch (err) {
            const { message, cause } = walletSafeTrustFailure(
                err,
                WALLET_PROVIDER_TRUST_LISTS_UNAVAILABLE,
                "Wallet attestation verification failed: ",
            );
            throw new UnauthorizedException(message, { cause });
        }
    }

    /**
     * Validate the wallet provider's X.509 certificate against configured trust lists.
     * Returns the matched entity and trust store for use in status list verification.
     * @param clientAttestationJwt The wallet attestation JWT
     * @param trustListInputs Trust lists to validate against
     * @returns The matched entity and trust store
     * @throws UnauthorizedException if certificate is not trusted, or a
     * certificate of its path is outside its validity period
     */
    private async validateWalletSolutionCertificate(
        clientAttestationJwt: string,
        trustListInputs: TrustListRef[],
        tenantId: string,
    ): Promise<{
        matchedEntity: MatchedTrustedEntity | null;
        trustStore: BuiltTrustStore | null;
    }> {
        const trustListRefs = normalizeTrustListRefs(trustListInputs);

        if (trustListRefs.length === 0) {
            throw new UnauthorizedException(
                "No wallet provider trust lists configured for wallet attestation verification",
            );
        }

        // Extract X.509 certificate chain from JWT header
        const header = decodeProtectedHeader(clientAttestationJwt);
        const x5c = header.x5c;

        if (!x5c || x5c.length === 0) {
            throw new UnauthorizedException(
                "Wallet attestation JWT does not contain X.509 certificate chain (x5c header)",
            );
        }

        // Build trust list source from configured URLs
        const trustListSource: TrustListSource = {
            lotes: trustListRefs,
            tenantId,
            acceptedServiceTypes: [...walletSolutionServiceTypes],
        };

        // Fetch and build the trust store
        const trustStore = await this.loadTrustStore(trustListSource);

        // Says when outdated lists were left out, so a missing provider is
        // not mistaken for one that is not listed at all.
        const note = discardedTrustListsNote(trustStore.discarded);
        if (trustStore.entities.length === 0) {
            throw new UnauthorizedException(
                `No trusted wallet providers found in configured trust lists${note}`,
            );
        }

        try {
            const match =
                await this.x509ValidationService.matchAttestationSigner(
                    x5c,
                    trustStore.entities,
                );

            if (!match) {
                throw new UnauthorizedException(
                    `Wallet provider certificate is not trusted - no matching entity in trust list${note}`,
                );
            }

            this.logger.debug(
                `Wallet attestation validated against trusted entity: ${match.entity.entityId ?? "unknown"}`,
            );

            return { matchedEntity: match, trustStore };
        } catch (err) {
            if (err instanceof UnauthorizedException) {
                throw err;
            }
            if (err instanceof AttestationCertificateNotValid) {
                throw new UnauthorizedException(
                    `Wallet attestation certificate chain is not valid: ${err.message}`,
                );
            }
            throw new UnauthorizedException(
                `Certificate chain validation failed: ${err instanceof Error ? err.message : "Unknown error"}${note}`,
            );
        }
    }

    /**
     * Check the status of a key attestation (OpenID4VCI 1.0, Appendix D.1)
     * whose signer the caller matched in the wallet-provider trust lists. In
     * the EUDI Wallet, this is the wallet unit attestation; its status list
     * says whether the wallet unit was revoked. The checks are those of a
     * wallet attestation's status list.
     * @param tenantId The tenant the key attestation was presented to
     * @param keyAttestationJwt The key attestation JWT
     * @param matchedEntity The trusted entity that signed the attestation
     * @param trustStore The trust store the entity was matched in
     * @param statusCheckMode strict, best_effort or disabled
     * @returns The attestation's `status_list` reference, also when the
     * check is disabled or the list could not be fetched in best_effort;
     * undefined when the attestation has none, or its claim is malformed
     * and the check is disabled
     * @throws AttestationStatusRejected if the attestation is revoked or
     * suspended, or if the status check failed and the mode does not
     * tolerate it; the message starts with "Key attestation" or names the
     * status list signature
     */
    async checkKeyAttestationStatus(
        tenantId: string,
        keyAttestationJwt: string,
        matchedEntity: MatchedTrustedEntity,
        trustStore: BuiltTrustStore,
        statusCheckMode: RevocationCheckMode,
    ): Promise<StatusListEntry | undefined> {
        try {
            return await this.validateAttestationStatus(
                tenantId,
                keyAttestationJwt,
                matchedEntity,
                trustStore,
                statusCheckMode,
                "Key attestation",
            );
        } catch (error) {
            if (error instanceof UnauthorizedException) {
                throw new AttestationStatusRejected(error.message, {
                    cause: error.cause,
                });
            }
            throw error;
        }
    }

    /**
     * Read the current status of wallet unit attestations (key attestations)
     * from their status list, for credentials issued under them. The
     * provider is matched again in the current wallet-provider trust lists,
     * and the list must be signed as at issuance. The list is verified once
     * for all indexes. The validity periods of the attestations'
     * certificates are not checked again.
     * @param tenantId The tenant whose trust lists apply
     * @param certificates The attestations' `x5c`, leaf first
     * @param uri The attestations' `status.status_list.uri`
     * @param indexes Their `status.status_list.idx` values
     * @param trustLists The tenant's wallet-provider trust lists
     * @returns The status value per index; an index outside the list is
     * left out and logged
     * @throws Error when the provider is no longer trusted, or the list
     * cannot be fetched, is not signed by the provider or cannot be read
     */
    async readWalletUnitStatuses(
        tenantId: string,
        certificates: string[],
        uri: string,
        indexes: number[],
        trustLists: TrustListRef[],
    ): Promise<Map<number, number>> {
        const trustListRefs = normalizeTrustListRefs(trustLists);
        if (trustListRefs.length === 0) {
            throw new Error("No wallet provider trust lists are configured");
        }
        const trustStore = await this.trustStoreService.getTrustStore({
            lotes: trustListRefs,
            tenantId,
            acceptedServiceTypes: [...walletSolutionServiceTypes],
        });
        // The attestation's certificates were checked when it was presented.
        // They expire while the provider keeps its status list; checking them
        // here would stop the revocation of a wallet unit once they have.
        const matchedEntity =
            await this.x509ValidationService.matchAttestationSigner(
                certificates,
                trustStore.entities,
                { ignoreValidityPeriods: true },
            );
        if (!matchedEntity) {
            throw new Error(
                `The wallet provider is no longer in the wallet provider trust lists${discardedTrustListsNote(trustStore.discarded)}`,
            );
        }
        const statusListJwt =
            await this.statusListVerifierService.getStatusListJwt(
                uri,
                tenantId,
            );
        if (
            !(await this.verifyStatusListSignature(
                statusListJwt,
                matchedEntity,
                trustStore,
            ))
        ) {
            throw new Error(
                "Status list JWT signature verification failed - not signed by the wallet provider's trusted revocation or wallet attestation certificate",
            );
        }
        const statuses = new Map<number, number>();
        for (const idx of indexes) {
            try {
                statuses.set(
                    idx,
                    this.statusListVerifierService.getStatusFromStatusListJwt(
                        statusListJwt,
                        { uri, idx },
                        this.settings.cryptoToleranceSeconds,
                    ).status,
                );
            } catch (error) {
                // A claim problem of the token fails every index alike; only
                // an index outside the list is particular to one attestation.
                if (!(error instanceof StatusListIndexOutOfRange)) throw error;
                this.logger.warn(
                    `Wallet unit status in ${uri}: ${error.message}`,
                );
            }
        }
        return statuses;
    }

    /**
     * Validate the status of an attestation JWT if it contains a status claim.
     * The status claim is optional per the spec, so if not present, validation passes.
     * Also verifies that the status list JWT is signed by a revocation certificate
     * from the same trusted entity that issued the attestation, or by
     * its wallet attestation certificate if it has no revocation certificate.
     * @param tenantId The tenant the attestation was presented to
     * @param attestationJwt The wallet or key attestation JWT
     * @param matchedEntity The matched trusted entity from certificate validation
     * @param trustStore The trust store used for validation
     * @param statusCheckMode strict, best_effort or disabled
     * @param label How messages name the attestation
     * @returns The attestation's `status_list` reference, if it has one
     * @throws UnauthorizedException if the attestation has been revoked or
     * suspended, or if the status check failed and the mode does not tolerate it
     */
    private async validateAttestationStatus(
        tenantId: string,
        attestationJwt: string,
        matchedEntity: MatchedTrustedEntity | null,
        trustStore: BuiltTrustStore | null,
        statusCheckMode: RevocationCheckMode,
        label: AttestationLabel = "Wallet attestation",
    ): Promise<StatusListEntry | undefined> {
        const policy = revocationModeToPolicy(statusCheckMode);
        if (!policy.enabled) {
            this.logger.debug(
                `${label} status check disabled - skipping status check`,
            );
            // Malformed claims are accepted when the check is disabled.
            try {
                return this.statusListVerifierService.getStatusEntryFromJwt(
                    attestationJwt,
                );
            } catch {
                return undefined;
            }
        }

        let statusEntry: StatusListEntry | undefined;
        try {
            // Get the status entry from the JWT. A malformed status claim
            // throws and rejects in both strict and best_effort.
            statusEntry =
                this.statusListVerifierService.getStatusEntryFromJwt(
                    attestationJwt,
                );

            // No status claim in JWT - this is allowed per spec
            if (!statusEntry) {
                this.logger.debug(
                    `${label} does not contain status claim - skipping status check`,
                );
                return undefined;
            }

            // Fetch the status list JWT
            const statusListJwt =
                await this.statusListVerifierService.getStatusListJwt(
                    statusEntry.uri,
                    tenantId,
                );

            // Verify the status list JWT signature against the revocation cert
            const signatureValid = await this.verifyStatusListSignature(
                statusListJwt,
                matchedEntity,
                trustStore,
            );

            if (!signatureValid) {
                throw new UnauthorizedException(
                    "Status list JWT signature verification failed - not signed by the wallet provider's trusted revocation or wallet attestation certificate",
                );
            }

            // Read the status from the token whose signature was just
            // verified. Fetching the list again could return another token.
            // A token signed by the provider that is not the list this
            // attestation names (another sub), has expired or cannot be read
            // rejects the attestation.
            let statusResult: StatusCheckResult;
            try {
                statusResult =
                    this.statusListVerifierService.getStatusFromStatusListJwt(
                        statusListJwt,
                        statusEntry,
                        this.settings.cryptoToleranceSeconds,
                    );
            } catch (err) {
                // Fail closed: the list is signed by the provider, so any
                // error reading it rejects rather than skips the check.
                throw new UnauthorizedException(
                    `${label} status list rejected: ${err instanceof Error ? err.message : "Unknown error"}`,
                );
            }

            // Check if the status indicates the attestation is valid
            if (!statusResult.isValid) {
                this.logger.warn(
                    `${label} status check failed: ${statusResult.description}`,
                );
                throw new UnauthorizedException(
                    `${label} is not valid: ${statusResult.description}`,
                );
            }

            this.logger.debug(
                `${label} status verified: ${statusResult.description}`,
            );
        } catch (err) {
            this.handleStatusCheckError(err, policy.failClosed, label);
        }
        return statusEntry;
    }

    /**
     * Decide on a status check that threw. Rejections keep their message;
     * best_effort (not fail-closed) only tolerates a list that could not be
     * fetched, and an unreadable list or a bad index still rejects.
     */
    private handleStatusCheckError(
        err: unknown,
        failClosed: boolean | undefined,
        label: AttestationLabel,
    ): void {
        if (err instanceof UnauthorizedException) {
            throw err;
        }
        const reason = err instanceof Error ? err.message : "Unknown error";
        if (!failClosed && err instanceof RevocationListUnavailableError) {
            this.logger.warn(
                `${label} status list unavailable, accepting (best_effort): ${reason}`,
            );
            return;
        }
        // The reason names the status list URI and the fetch error; it stays
        // in the log so the wallet cannot probe the network with it.
        this.logger.warn(`${label} status check failed: ${reason}`);
        throw new UnauthorizedException(`${label} status check failed`, {
            cause: err instanceof Error ? err : undefined,
        });
    }

    /**
     * Verify the signature of a status list JWT against the revocation
     * certificates of the matched trusted entity, any of which may sign it,
     * or its wallet attestation (issuance) certificate if it has no
     * revocation certificate.
     * @param statusListJwt The status list JWT to verify
     * @param matchedEntity The matched trusted entity
     * @param trustStore The trust store
     * @returns true if the signature is valid and from the trusted signer cert
     */
    private async verifyStatusListSignature(
        statusListJwt: string,
        matchedEntity: MatchedTrustedEntity | null,
        trustStore: BuiltTrustStore | null,
    ): Promise<boolean> {
        try {
            // Parse the status list JWT header
            const header = decodeProtectedHeader(statusListJwt);
            const x5c = header.x5c;

            // Extract public key from x5c and verify signature
            if (!x5c || x5c.length === 0) {
                // If no x5c in status list, we can't verify against trust chain
                // Accept if no trust validation is configured
                if (!matchedEntity) {
                    return true;
                }
                this.logger.warn(
                    "Status list JWT missing x5c header - cannot verify against trust chain",
                );
                return false;
            }

            // Verify the JWT signature
            const cert = new X509Certificate(Buffer.from(x5c[0], "base64"));
            const publicKey = cert.publicKey.export({ format: "jwk" }) as JWK;
            const crypto =
                this.cryptoImplementationService.getCryptoFromJwk(publicKey);
            const verifier = await crypto.getVerifier(publicKey);

            // Split JWT and verify
            const [headerB64, payloadB64, signatureB64] =
                statusListJwt.split(".");
            const data = `${headerB64}.${payloadB64}`;

            // The verifier resolves to false on a bad signature; it only
            // rejects when the signature cannot be checked at all.
            const sigOk = await verifier(data, signatureB64).catch((e) => {
                this.logger.debug(
                    `Status list JWT signature check failed: ${e?.message ?? e}`,
                );
                return false;
            });
            if (!sigOk) {
                this.logger.debug("Status list JWT signature invalid");
                return false;
            }

            // If no entity was matched (no trust list configured), accept if signature is valid
            if (!matchedEntity || !trustStore) {
                return true;
            }

            // The status list must be signed under one of the entity's
            // revocation certificates: every WalletSolution/Revocation
            // service, or else every EAA/Revocation service. An entity
            // without one must sign it under the certificate that its wallet
            // attestations are signed under.
            const signers =
                this.x509ValidationService.statusListSigners(matchedEntity);

            // Build and verify the status list's certificate chain
            const presented = this.x509ValidationService.parseX5c(x5c);
            const leaf = presented[0];

            // Get all certs for path building, the expected signers first:
            // when anchors share subject and key, the path then ends at a
            // signer certificate that is checked below.
            const allCerts = trustStore.entities.flatMap((e) =>
                e.services.map((s) => ({ certValue: s.certValue })),
            );
            const anchors = this.x509ValidationService.parseTrustAnchors([
                ...signers.map((s) => ({ certValue: s.certValue })),
                ...allCerts,
            ]);

            let path: x509.X509Certificate[];
            try {
                path = await this.x509ValidationService.buildPath(
                    leaf,
                    presented,
                    anchors,
                );
            } catch (e: any) {
                this.logger.debug(
                    `Status list chain build failed: ${e?.message ?? e}`,
                );
                return false;
            }

            // Get thumbprints for comparison
            const statusLeafThumb = await this.getThumbprint(presented[0]);
            const statusEndThumb = await this.getThumbprint(path.at(-1)!);
            const entityId = matchedEntity.entity.entityId ?? "unknown";

            // Check if the status list is signed under a signer cert from the
            // same entity. CA: the path must terminate at this cert. Pinned
            // (non-CA): the leaf must match.
            const statusMatchesSigner =
                await this.x509ValidationService.matchesStatusListSigner(
                    path,
                    matchedEntity,
                    "leaf",
                );

            const kind =
                signers[0].serviceTypeIdentifier ===
                matchedEntity.issuanceServiceType
                    ? "the wallet attestation certificate"
                    : "a revocation certificate";
            if (!statusMatchesSigner) {
                this.logger.warn(
                    `Status list is NOT signed by ${kind} from the same TrustedEntity. ` +
                        `Entity: ${entityId}, ` +
                        `Status list leaf cert: ${statusLeafThumb}, ` +
                        `Status list end cert: ${statusEndThumb}`,
                );
                return false;
            }

            this.logger.debug(
                `Status list verified against ${kind} from entity: ${entityId}`,
            );
            return true;
        } catch (e: any) {
            this.logger.error(
                `Error verifying status list signature: ${e?.message ?? e}`,
            );
            return false;
        }
    }

    /**
     * Calculate the SHA-256 thumbprint of an X.509 certificate.
     */
    private async getThumbprint(cert: x509.X509Certificate): Promise<string> {
        const thumbBuffer = await cert.getThumbprint("SHA-256");
        return Buffer.from(thumbBuffer).toString("hex").toLowerCase();
    }
}
