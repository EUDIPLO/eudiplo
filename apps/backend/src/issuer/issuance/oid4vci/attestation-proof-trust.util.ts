import { Logger } from "@nestjs/common";
import { decodeProtectedHeader } from "jose";
import { isAttestationChainRejection } from "../../../trust/domain/attestation-certificate-validity.js";
import {
    type DiscardedTrustList,
    discardedTrustListsNote,
    walletSafeTrustFailure,
} from "../../../trust/domain/trust-list-freshness.js";
import type {
    BuiltTrustStore,
    TrustStoreService,
} from "../../../trust/trust-store.service.js";
import {
    normalizeTrustListRefs,
    TrustListSource,
    walletSolutionServiceTypes,
} from "../../../trust/types.js";
import type {
    MatchedTrustedEntity,
    X509ValidationService,
} from "../../../trust/x509-validation.service.js";
import { TrustListRef } from "../../../verifier/presentations/entities/presentation-config.entity.js";
import { CredentialRequestException } from "./exceptions/index.js";

export interface AttestationProofTrustValidationDeps {
    tenantId: string;
    trustStoreService: TrustStoreService;
    x509ValidationService: X509ValidationService;
    /** Where a rejected key attestation's reason is logged. */
    logger?: Pick<Logger, "warn">;
}

/** The trusted provider of a key attestation, for its status check. */
export interface AttestationProofTrust {
    matchedEntity: MatchedTrustedEntity;
    trustStore: BuiltTrustStore;
    /** The attestation's `x5c`, leaf first. */
    certificates: string[];
}

const defaultLogger = new Logger("AttestationProofTrust");

/** Answer when the provider of a key attestation cannot be decided. */
const ATTESTATION_PROOF_NOT_VALIDATED =
    "Attestation proof x5c chain could not be validated";

/**
 * Validate attestation proof signer chain against configured trusted wallet providers.
 * An attestation must always have a trusted signer, even when it is optional.
 *
 * When the provider cannot be decided (a trust list or reference that cannot
 * be loaded, a header or certificate that cannot be read), the wallet gets a
 * fixed `invalid_proof` text, since the reason can name a trust list URL or
 * an internal address; the reason is logged with the tenant instead. A
 * certificate of the attestation's path outside its validity period answers
 * `invalid_proof` with the certificate's place in the path and its period,
 * an `x5c` with more certificates than `MAX_CERTIFICATE_CHAIN_LENGTH` with
 * their number.
 */
export async function validateAttestationProofTrust(
    keyAttestationJwt: string,
    trustListRefsInput: TrustListRef[],
    deps: AttestationProofTrustValidationDeps,
): Promise<AttestationProofTrust> {
    // Outdated lists left out of the store, named by count in the answer so a
    // missing provider is not mistaken for one that is not listed at all.
    let discarded: DiscardedTrustList[] = [];
    try {
        const trustListRefs = normalizeTrustListRefs(trustListRefsInput);
        if (trustListRefs.length === 0) {
            throw new CredentialRequestException(
                "invalid_proof",
                "No wallet provider trust lists configured for key attestation verification",
            );
        }

        const header = decodeProtectedHeader(keyAttestationJwt);
        const x5c = header.x5c;
        if (!Array.isArray(x5c) || x5c.length === 0) {
            throw new CredentialRequestException(
                "invalid_proof",
                "Attestation proof must contain an x5c certificate chain for trust validation",
            );
        }

        const trustListSource: TrustListSource = {
            lotes: trustListRefs,
            tenantId: deps.tenantId,
            acceptedServiceTypes: [...walletSolutionServiceTypes],
        };

        const trustStore =
            await deps.trustStoreService.getTrustStore(trustListSource);
        discarded = trustStore.discarded;
        if (trustStore.entities.length === 0) {
            throw new CredentialRequestException(
                "invalid_proof",
                `No trusted wallet providers found in configured trust lists${discardedTrustListsNote(discarded)}`,
            );
        }

        const matched = await deps.x509ValidationService.matchAttestationSigner(
            x5c,
            trustStore.entities,
        );

        if (!matched) {
            throw new CredentialRequestException(
                "invalid_proof",
                `Attestation proof signer is not trusted by configured wallet provider trust lists${discardedTrustListsNote(discarded)}`,
            );
        }
        return { matchedEntity: matched, trustStore, certificates: [...x5c] };
    } catch (error) {
        if (error instanceof CredentialRequestException) {
            throw error;
        }
        if (isAttestationChainRejection(error)) {
            throw new CredentialRequestException(
                "invalid_proof",
                `Attestation proof certificate chain is not valid: ${error.message}`,
            );
        }
        const { message, cause, outdated } = walletSafeTrustFailure(
            error,
            `${ATTESTATION_PROOF_NOT_VALIDATED}${discardedTrustListsNote(discarded)}`,
        );
        // An outdated-lists message is its own reason; for the fixed text,
        // the cause names the list or certificate that failed.
        const reason = outdated
            ? message
            : `${message}: ${cause?.message || "Unknown error"}`;
        (deps.logger ?? defaultLogger).warn(
            `Key attestation validation failed for tenant ${deps.tenantId}: ${reason}`,
        );
        throw new CredentialRequestException("invalid_proof", message);
    }
}

/**
 * Validate the provider of a key attestation embedded in a holder's JWT proof.
 * Signature verification and holder-key binding are handled by the OID4VCI library.
 * @returns The key attestation and its trusted provider, or undefined when
 * the proof has no key attestation
 */
export async function validateJwtProofAttestationTrust(
    proofJwt: string,
    trustListRefs: TrustListRef[],
    deps: AttestationProofTrustValidationDeps,
): Promise<
    (AttestationProofTrust & { keyAttestationJwt: string }) | undefined
> {
    const keyAttestation = decodeProtectedHeader(proofJwt).key_attestation;
    if (keyAttestation === undefined) return undefined;
    if (typeof keyAttestation !== "string" || !keyAttestation) {
        throw new CredentialRequestException(
            "invalid_proof",
            "JWT proof key_attestation must be a compact JWT",
        );
    }
    const trust = await validateAttestationProofTrust(
        keyAttestation,
        trustListRefs,
        deps,
    );
    return { ...trust, keyAttestationJwt: keyAttestation };
}
