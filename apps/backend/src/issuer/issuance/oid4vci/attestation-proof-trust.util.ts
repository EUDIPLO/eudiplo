import { decodeProtectedHeader } from "jose";
import {
    type DiscardedTrustList,
    discardedTrustListsNote,
    OutdatedTrustListsError,
} from "../../../trust/domain/trust-list-freshness.js";
import { TrustStoreService } from "../../../trust/trust-store.service.js";
import {
    normalizeTrustListRefs,
    TrustListSource,
    walletSolutionServiceTypes,
} from "../../../trust/types.js";
import { X509ValidationService } from "../../../trust/x509-validation.service.js";
import { TrustListRef } from "../../../verifier/presentations/entities/presentation-config.entity.js";
import { CredentialRequestException } from "./exceptions/index.js";

export interface AttestationProofTrustValidationDeps {
    tenantId: string;
    trustStoreService: TrustStoreService;
    x509ValidationService: X509ValidationService;
}

/**
 * Validate attestation proof signer chain against configured trusted wallet providers.
 * An attestation must always have a trusted signer, even when it is optional.
 */
export async function validateAttestationProofTrust(
    keyAttestationJwt: string,
    trustListRefsInput: TrustListRef[],
    deps: AttestationProofTrustValidationDeps,
): Promise<void> {
    const trustListRefs = normalizeTrustListRefs(trustListRefsInput);

    if (trustListRefs.length === 0) {
        throw new CredentialRequestException(
            "invalid_proof",
            "No wallet provider trust lists configured for key attestation verification",
        );
    }

    // Outdated lists left out of the store, named by count in the answer so a
    // missing provider is not mistaken for one that is not listed at all.
    let discarded: DiscardedTrustList[] = [];
    try {
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
    } catch (error) {
        if (error instanceof CredentialRequestException) {
            throw error;
        }
        // Its message is safe for wallets and says why no provider is trusted.
        if (error instanceof OutdatedTrustListsError) {
            throw new CredentialRequestException(
                "invalid_proof",
                error.message,
            );
        }
        throw new CredentialRequestException(
            "invalid_proof",
            `Attestation proof x5c chain could not be validated${discardedTrustListsNote(discarded)}`,
        );
    }
}

/**
 * Validate the provider of a key attestation embedded in a holder's JWT proof.
 * Signature verification and holder-key binding are handled by the OID4VCI library.
 */
export async function validateJwtProofAttestationTrust(
    proofJwt: string,
    trustListRefs: TrustListRef[],
    deps: AttestationProofTrustValidationDeps,
): Promise<void> {
    const keyAttestation = decodeProtectedHeader(proofJwt).key_attestation;
    if (keyAttestation === undefined) return;
    if (typeof keyAttestation !== "string" || !keyAttestation) {
        throw new CredentialRequestException(
            "invalid_proof",
            "JWT proof key_attestation must be a compact JWT",
        );
    }
    await validateAttestationProofTrust(keyAttestation, trustListRefs, deps);
}
