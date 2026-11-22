type CredentialProofType = "jwt" | "attestation";

export interface ResolvedCredentialProofs {
    proofType: CredentialProofType;
    values: string[];
}

export class CredentialProofResolutionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "CredentialProofResolutionError";
    }
}

export class ResolveCredentialProofs {
    /**
     * The key proofs of a credential request. A configuration that needs no
     * key proof (`requiresKeyProof`) publishes no `proof_types_supported`,
     * so `proofs` is optional for it (OpenID4VCI 1.0 Section 8.2). Proofs a
     * wallet sends anyway are ignored, not verified: they bind nothing, and
     * ignoring them keeps them from deciding how many credentials are issued
     * or consuming a nonce. Returns undefined then.
     */
    execute(
        proofs: unknown,
        options: { required: boolean },
    ): ResolvedCredentialProofs | undefined {
        if (!options.required) return undefined;
        const proofRecord =
            typeof proofs === "object" && proofs !== null
                ? (proofs as Record<string, unknown>)
                : undefined;
        const jwtProofs = proofRecord?.jwt;
        const attestationProofs = proofRecord?.attestation;
        const validJwtProofs = Array.isArray(jwtProofs)
            ? jwtProofs.filter(
                  (proof): proof is string => typeof proof === "string",
              )
            : [];
        const validAttestationProofs = Array.isArray(attestationProofs)
            ? attestationProofs.filter(
                  (proof): proof is string => typeof proof === "string",
              )
            : [];
        const hasJwtProofs = validJwtProofs.length > 0;
        const hasAttestationProofs = validAttestationProofs.length > 0;

        if (hasJwtProofs && hasAttestationProofs) {
            throw new CredentialProofResolutionError(
                "Credential request must include exactly one supported proof type (jwt or attestation)",
            );
        }
        if (hasJwtProofs) {
            return { proofType: "jwt", values: validJwtProofs };
        }
        if (hasAttestationProofs) {
            if (validAttestationProofs.length !== 1) {
                throw new CredentialProofResolutionError(
                    "Attestation proof type requires exactly one key attestation JWT",
                );
            }
            return { proofType: "attestation", values: validAttestationProofs };
        }

        throw new CredentialProofResolutionError(
            "The proofs parameter is missing or does not contain supported proof types (jwt, attestation)",
        );
    }
}
