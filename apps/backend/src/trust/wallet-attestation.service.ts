import { X509Certificate } from "node:crypto";
import {
    Inject,
    Injectable,
    Logger,
    UnauthorizedException,
} from "@nestjs/common";
import { Openid4vciIssuer } from "@openid4vc/openid4vci";
import * as x509 from "@peculiar/x509";
import { decodeProtectedHeader, JWK } from "jose";
import { Span } from "nestjs-otel";
import { CryptoService } from "../crypto/crypto.service.js";
import { CryptoImplementationService } from "../crypto/key/crypto-implementation/crypto-implementation.service.js";
import { TrustListRef } from "../verifier/presentations/entities/presentation-config.entity.js";
import {
    RevocationListUnavailableError,
    revocationModeToPolicy,
} from "./revocation-policy.util.js";
import {
    StatusCheckResult,
    StatusListVerifierService,
} from "./status-list-verifier.service.js";
import { BuiltTrustStore, TrustStoreService } from "./trust-store.service.js";
import {
    normalizeTrustListRefs,
    RevocationCheckMode,
    ServiceTypeIdentifiers,
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

export interface ClientAttestation {
    clientAttestationJwt: string;
    clientAttestationPopJwt?: string;
}

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
     * @throws UnauthorizedException if attestation is required but not provided, or if provided but invalid
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
            // First verify the attestation JWT structure and PoP
            await this.getIssuer(tenantId).verifyWalletAttestation({
                authorizationServer,
                clientAttestationJwt: clientAttestation.clientAttestationJwt,
                clientAttestationPopJwt:
                    clientAttestation.clientAttestationPopJwt!,
                allowedSkewInSeconds: this.settings.cryptoToleranceSeconds,
            });

            // Then validate the X.509 certificate against trust lists and get the matched entity
            const { matchedEntity, trustStore } =
                await this.validateWalletSolutionCertificate(
                    clientAttestation.clientAttestationJwt,
                    walletProviderTrustLists,
                    tenantId,
                );

            // Check the status list if present in the attestation JWT
            // Pass the matched entity and trust store for signature verification
            await this.validateWalletAttestationStatus(
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
            throw new UnauthorizedException(
                `Wallet attestation verification failed: ${err instanceof Error ? err.message : "Unknown error"}`,
                { cause: err instanceof Error ? err : undefined },
            );
        }
    }

    /**
     * Validate the wallet provider's X.509 certificate against configured trust lists.
     * Returns the matched entity and trust store for use in status list verification.
     * @param clientAttestationJwt The wallet attestation JWT
     * @param trustListInputs Trust lists to validate against
     * @returns The matched entity and trust store
     * @throws UnauthorizedException if certificate is not trusted
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
        const trustStore =
            await this.trustStoreService.getTrustStore(trustListSource);

        if (trustStore.entities.length === 0) {
            throw new UnauthorizedException(
                "No trusted wallet providers found in configured trust lists",
            );
        }

        // Parse the certificate chain
        const certChain = this.x509ValidationService.parseX5c(x5c);
        const leaf = certChain[0];

        // Build and validate the certificate path against trust anchors
        const trustAnchors = this.x509ValidationService.parseTrustAnchors(
            trustStore.entities.flatMap((e) => e.services),
        );

        try {
            const path = await this.x509ValidationService.buildPath(
                leaf,
                certChain,
                trustAnchors,
            );

            // Check if the path matches any trusted entity (using WalletProvider service type)
            const match =
                await this.x509ValidationService.pathMatchesTrustedEntities(
                    path,
                    trustStore.entities,
                    "leaf",
                    ServiceTypeIdentifiers.WalletSolution,
                );

            if (!match) {
                throw new UnauthorizedException(
                    "Wallet provider certificate is not trusted - no matching entity in trust list",
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
            throw new UnauthorizedException(
                `Certificate chain validation failed: ${err instanceof Error ? err.message : "Unknown error"}`,
            );
        }
    }

    /**
     * Validate the status of a wallet attestation JWT if it contains a status claim.
     * The status claim is optional per the spec, so if not present, validation passes.
     * Also verifies that the status list JWT is signed by the revocation certificate
     * from the same trusted entity that issued the wallet attestation, or by
     * its wallet attestation certificate if it has no revocation certificate.
     * @param clientAttestationJwt The wallet attestation JWT
     * @param matchedEntity The matched trusted entity from certificate validation
     * @param trustStore The trust store used for validation
     * @param statusCheckMode strict, best_effort or disabled
     * @throws UnauthorizedException if the attestation has been revoked or
     * suspended, or if the status check failed and the mode does not tolerate it
     */
    private async validateWalletAttestationStatus(
        clientAttestationJwt: string,
        matchedEntity: MatchedTrustedEntity | null,
        trustStore: BuiltTrustStore | null,
        statusCheckMode: RevocationCheckMode,
    ): Promise<void> {
        const policy = revocationModeToPolicy(statusCheckMode);
        if (!policy.enabled) {
            this.logger.debug(
                "Wallet attestation status check disabled - skipping status check",
            );
            return;
        }

        try {
            // Get the status entry from the JWT. A malformed status claim
            // throws and rejects in both strict and best_effort.
            const statusEntry =
                this.statusListVerifierService.getStatusEntryFromJwt(
                    clientAttestationJwt,
                );

            // No status claim in JWT - this is allowed per spec
            if (!statusEntry) {
                this.logger.debug(
                    "Wallet attestation does not contain status claim - skipping status check",
                );
                return;
            }

            // Fetch the status list JWT
            const statusListJwt =
                await this.statusListVerifierService.getStatusListJwt(
                    statusEntry.uri,
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
                    `Wallet attestation status list rejected: ${err instanceof Error ? err.message : "Unknown error"}`,
                );
            }

            // Check if the status indicates the attestation is valid
            if (!statusResult.isValid) {
                this.logger.warn(
                    `Wallet attestation status check failed: ${statusResult.description}`,
                );
                throw new UnauthorizedException(
                    `Wallet attestation is not valid: ${statusResult.description}`,
                );
            }

            this.logger.debug(
                `Wallet attestation status verified: ${statusResult.description}`,
            );
        } catch (err) {
            this.handleStatusCheckError(err, policy.failClosed);
        }
    }

    /**
     * Decide on a status check that threw. Rejections keep their message;
     * best_effort (not fail-closed) only tolerates a list that could not be
     * fetched, and an unreadable list or a bad index still rejects.
     */
    private handleStatusCheckError(
        err: unknown,
        failClosed: boolean | undefined,
    ): void {
        if (err instanceof UnauthorizedException) {
            throw err;
        }
        const reason = err instanceof Error ? err.message : "Unknown error";
        if (!failClosed && err instanceof RevocationListUnavailableError) {
            this.logger.warn(
                `Wallet attestation status list unavailable, accepting (best_effort): ${reason}`,
            );
            return;
        }
        // The reason names the status list URI and the fetch error; it stays
        // in the log so the wallet cannot probe the network with it.
        this.logger.warn(`Wallet attestation status check failed: ${reason}`);
        throw new UnauthorizedException(
            "Wallet attestation status check failed",
            { cause: err instanceof Error ? err : undefined },
        );
    }

    /**
     * Verify the signature of a status list JWT against the revocation certificate
     * from the matched trusted entity, or its wallet attestation (issuance)
     * certificate if it has no revocation certificate.
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

            // The status list must be signed under the entity's revocation
            // certificate. An entity without one must sign it under the
            // certificate that its wallet attestations are signed under.
            const signer =
                matchedEntity.revocationCert &&
                matchedEntity.revocationThumbprint
                    ? {
                          cert: matchedEntity.revocationCert,
                          thumb: matchedEntity.revocationThumbprint,
                          kind: "revocation",
                      }
                    : {
                          cert: matchedEntity.issuanceCert,
                          thumb: matchedEntity.issuanceThumbprint,
                          kind: "wallet attestation",
                      };

            // Build and verify the status list's certificate chain
            const presented = this.x509ValidationService.parseX5c(x5c);
            const leaf = presented[0];

            // Get all certs for path building, the expected signer first: when
            // anchors share subject and key, the path then ends at the signer
            // certificate that is checked below.
            const allCerts = trustStore.entities.flatMap((e) =>
                e.services.map((s) => ({ certValue: s.certValue })),
            );
            const anchors = this.x509ValidationService.parseTrustAnchors([
                {
                    certValue: Buffer.from(signer.cert.rawData).toString(
                        "base64",
                    ),
                },
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

            // Check if the status list is signed under the signer cert from the same entity
            // CA: the path must terminate at this cert. Pinned (non-CA): the
            // leaf must match.
            const statusMatchesSigner = this.x509ValidationService.isCaCert(
                signer.cert,
            )
                ? signer.thumb === statusEndThumb
                : signer.thumb === statusLeafThumb;

            if (!statusMatchesSigner) {
                this.logger.warn(
                    `Status list is NOT signed by the ${signer.kind} certificate from the same TrustedEntity. ` +
                        `Entity: ${matchedEntity.entity.entityId ?? "unknown"}, ` +
                        `Expected ${signer.kind} cert: ${signer.thumb}, ` +
                        `Status list leaf cert: ${statusLeafThumb}, ` +
                        `Status list end cert: ${statusEndThumb}`,
                );
                return false;
            }

            this.logger.debug(
                `Status list verified against ${signer.kind} cert from entity: ${matchedEntity.entity.entityId ?? "unknown"}`,
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
