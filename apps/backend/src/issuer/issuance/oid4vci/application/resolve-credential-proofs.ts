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
    execute(proofs: unknown): ResolvedCredentialProofs {
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
