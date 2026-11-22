import type { Jwk } from "@owf/jose";
import type { SessionData } from "../../../../session/domain/session-data.js";
import type {
    RevocationCheckMode,
    TrustListRef,
} from "../../../../trust/types.js";
import {
    assertMaintenancePeriodOpen,
    maintenancePeriodEnd,
} from "../../../configuration/credentials/domain/maintenance-period.js";
import type { WalletUnitReference } from "../../../status-list/domain/wallet-unit-reference.js";
import { InvalidCredentialProof } from "../domain/credential-proof-errors.js";
import {
    assertKeyAttestationRequirements,
    type KeyAttestationRequirements,
} from "../domain/key-attestation-requirements.js";
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
        /** How the status list of a key attestation is checked. */
        keyAttestationStatusCheckMode: RevocationCheckMode;
        /** Key attestation requirements of the credential configuration. */
        keyAttestationsRequired?: KeyAttestationRequirements;
        /**
         * Whether the credentials follow their wallet unit, so that the
         * status maintenance period of its attestations bounds them.
         */
        revokeWithWalletUnit?: boolean;
        onIssued: (credentialSize: number) => void;
    }): Promise<{ credential: string }[]> {
        const verifier = await this.verifier.prepare(
            command.session.tenantId,
            command.trustLists,
            command.keyAttestationStatusCheckMode,
        );
        // Verify every proof before issuing, so an invalid proof in a batch
        // does not leave credentials issued for the proofs before it.
        const verifiedProofs: {
            holderKeys: Jwk[];
            walletUnit?: WalletUnitReference;
        }[] = [];
        for (const proof of command.proofs) {
            const verified = await verifier.verify(proof, command.proofType);
            const holderKeys = verified.holderKeys;
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
            assertKeyAttestationRequirements(
                command.keyAttestationsRequired,
                verified,
            );
            // Refused before anything is issued: a maintenance period that
            // has ended leaves no credential of the batch any validity.
            const bound = maintenancePeriodEnd(
                command.revokeWithWalletUnit,
                verified.keyAttestation?.walletUnit,
                command.session.walletInstanceStatus,
            );
            if (bound) assertMaintenancePeriodOpen(bound);
            verifiedProofs.push({
                holderKeys,
                walletUnit: verified.keyAttestation?.walletUnit,
            });
        }
        const result: { credential: string }[] = [];
        for (const { holderKeys, walletUnit } of verifiedProofs) {
            const credentials = await this.issue.execute({
                credentialConfigurationId: command.credentialConfigurationId,
                holderKeys,
                session: command.session,
                claims: command.claims,
                issuanceSetId: command.issuanceSetId,
                walletUnit,
            });
            for (const credential of credentials) {
                result.push({ credential });
                command.onIssued(credential.length);
            }
        }
        return result;
    }
}
