import type { SessionData } from "../../../../session/domain/session-data.js";
import type { TrustListRef } from "../../../../trust/types.js";
import { InvalidCredentialProof } from "../domain/credential-proof-errors.js";
import type {
    CredentialProofVerifier,
    IssuanceProofType,
} from "../ports/credential-proof-verifier.js";
import type { IssueCredentialsForKeys } from "./issue-credentials-for-keys.js";

export class IssueCredentialsFromProofs {
    constructor(
        private readonly verifier: CredentialProofVerifier,
        private readonly issue: Pick<IssueCredentialsForKeys, "execute">,
    ) {}
    async execute(command: {
        proofs: string[];
        proofType: IssuanceProofType;
        session: SessionData;
        credentialConfigurationId: string;
        claims?: Record<string, unknown>;
        issuanceSetId: string;
        batchSize?: number;
        trustLists: TrustListRef[];
        onIssued: (credentialSize: number) => void;
    }): Promise<{ credential: string }[]> {
        const verifier = await this.verifier.prepare(
            command.session.tenantId,
            command.trustLists,
        );
        const result: { credential: string }[] = [];
        for (const proof of command.proofs) {
            const holderKeys = await verifier.verify(proof, command.proofType);
            if (command.proofType === "attestation") {
                if (!Array.isArray(holderKeys) || holderKeys.length === 0)
                    throw new InvalidCredentialProof(
                        "Attestation proof does not contain any attested keys",
                    );
                if (holderKeys.length > Math.max(command.batchSize ?? 1, 1))
                    throw new InvalidCredentialProof(
                        "Attestation proof contains more attested keys than the supported batch size",
                    );
            }
            const credentials = await this.issue.execute({
                credentialConfigurationId: command.credentialConfigurationId,
                holderKeys,
                session: command.session,
                claims: command.claims,
                issuanceSetId: command.issuanceSetId,
            });
            for (const credential of credentials) {
                result.push({ credential });
                command.onIssued(credential.length);
            }
        }
        return result;
    }
}
