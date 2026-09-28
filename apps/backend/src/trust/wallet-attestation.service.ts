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
import { StatusListVerifierService } from "./status-list-verifier.service.js";
import { BuiltTrustStore, TrustStoreService } from "./trust-store.service.js";
import {
    normalizeTrustListRefs,
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
     * @throws UnauthorizedException if attestation is required but not provided, or if provided but invalid
     */
    @Span("walletAttestation.verify")
    async verifyWalletAttestation(
        tenantId: string,
        clientAttestation: ClientAttestation | undefined,
        authorizationServer: string,
        walletAttestationRequired: boolean,
        walletProviderTrustLists: TrustListRef[],
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
     * from the same trusted entity that issued the wallet attestation.
     * @param clientAttestationJwt The wallet attestation JWT
     * @param matchedEntity The matched trusted entity from certificate validation
     * @param trustStore The trust store used for validation
     * @throws UnauthorizedException if the attestation has been revoked or suspended
     */
    private async validateWalletAttestationStatus(
        clientAttestationJwt: string,
        matchedEntity: MatchedTrustedEntity | null,
        trustStore: BuiltTrustStore | null,
    ): Promise<void> {
        try {
            // Get the status entry from the JWT
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
                    "Status list JWT signature verification failed - not signed by trusted revocation certificate",
                );
            }

            // Now check the actual status value
            const statusResult =
                await this.statusListVerifierService.checkStatus(
                    statusEntry.uri,
                    statusEntry.idx,
                );

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
            if (err instanceof UnauthorizedException) {
                throw err;
            }
            // Log the error but don't fail - status checking is optional
            // and network issues shouldn't block valid attestations
            this.logger.warn(
                `Failed to check wallet attestation status: ${err instanceof Error ? err.message : "Unknown error"}`,
            );
        }
    }

    /**
     * Verify the signature of a status list JWT against the revocation certificate
     * from the matched trusted entity.
     * @param statusListJwt The status list JWT to verify
     * @param matchedEntity The matched trusted entity
     * @param trustStore The trust store
     * @returns true if the signature is valid and from the trusted revocation cert
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

            const sigOk = await verifier(data, signatureB64)
                .then(() => true)
                .catch((e) => {
                    this.logger.debug(
                        `Status list JWT signature invalid: ${e?.message ?? e}`,
                    );
                    return false;
                });

            if (!sigOk) return false;

            // If no entity was matched (no trust list configured), accept if signature is valid
            if (!matchedEntity || !trustStore) {
                return true;
            }

            // Check if the matched entity has a revocation certificate
            if (!matchedEntity.revocationCert) {
                this.logger.warn(
                    `TrustedEntity ${matchedEntity.entity.entityId ?? "unknown"} ` +
                        `has no revocation certificate configured - accepting status list`,
                );
                return true;
            }

            // Build and verify the status list's certificate chain
            const presented = this.x509ValidationService.parseX5c(x5c);
            const leaf = presented[0];

            // Get all certs for path building
            const allCerts = trustStore.entities.flatMap((e) =>
                e.services.map((s) => ({ certValue: s.certValue })),
            );
            const anchors =
                this.x509ValidationService.parseTrustAnchors(allCerts);

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

            // Check if the status list is signed by the revocation cert from the same entity
            const revocationThumb = matchedEntity.revocationThumbprint!;
            const revocationIsCa = this.x509ValidationService.isCaCert(
                matchedEntity.revocationCert,
            );

            let statusMatchesRevocation = false;

            if (revocationIsCa) {
                // Revocation cert is CA: path must terminate at this cert
                statusMatchesRevocation = revocationThumb === statusEndThumb;
            } else {
                // Revocation cert is pinned (non-CA): leaf must match
                statusMatchesRevocation = revocationThumb === statusLeafThumb;
            }

            if (!statusMatchesRevocation) {
                this.logger.warn(
                    `Status list is NOT signed by the revocation certificate from the same TrustedEntity. ` +
                        `Entity: ${matchedEntity.entity.entityId ?? "unknown"}, ` +
                        `Expected revocation cert: ${revocationThumb}, ` +
                        `Status list leaf cert: ${statusLeafThumb}, ` +
                        `Status list end cert: ${statusEndThumb}`,
                );
                return false;
            }

            this.logger.debug(
                `Status list verified against revocation cert from entity: ${matchedEntity.entity.entityId ?? "unknown"}`,
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
