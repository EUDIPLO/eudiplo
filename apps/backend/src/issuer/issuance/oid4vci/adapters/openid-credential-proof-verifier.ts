import type { Jwk } from "@openid4vc/oauth2";
import { decodeJwt } from "jose";
import { AttestationStatusRejected } from "../../../../trust/domain/attestation-status-rejected.js";
import type { TrustStoreService } from "../../../../trust/trust-store.service.js";
import type {
    RevocationCheckMode,
    TrustListRef,
} from "../../../../trust/types.js";
import type { WalletAttestationService } from "../../../../trust/wallet-attestation.service.js";
import type { X509ValidationService } from "../../../../trust/x509-validation.service.js";
import type { WalletUnitReference } from "../../../status-list/domain/wallet-unit-reference.js";
import type { BuildIssuerMetadata } from "../application/build-issuer-metadata.js";
import {
    type AttestationProofTrust,
    validateAttestationProofTrust,
    validateJwtProofAttestationTrust,
} from "../attestation-proof-trust.util.js";
import { InvalidCredentialProof } from "../domain/credential-proof-errors.js";
import type {
    VerifiedCredentialProof,
    VerifiedKeyAttestation,
} from "../domain/key-attestation-requirements.js";
import type { Oid4vciSdkFactory } from "../oid4vci-sdk.factory.js";
import type {
    CredentialProofVerifier,
    IssuanceProofType,
} from "../ports/credential-proof-verifier.js";

/** Largest `status_list.idx` of a wallet unit that can be stored (int4). */
const MAX_WALLET_UNIT_STATUS_INDEX = 2_147_483_647;

export class OpenIdCredentialProofVerifier implements CredentialProofVerifier {
    constructor(
        private readonly sdk: Oid4vciSdkFactory,
        private readonly buildIssuerMetadata: BuildIssuerMetadata,
        private readonly trustStoreService: TrustStoreService,
        private readonly x509ValidationService: X509ValidationService,
        private readonly walletAttestations: Pick<
            WalletAttestationService,
            "checkKeyAttestationStatus"
        >,
    ) {}
    async prepare(
        tenantId: string,
        trustLists: TrustListRef[],
        statusCheckMode: RevocationCheckMode,
    ) {
        const issuer = this.sdk.issuer(tenantId);
        const issuerMetadata = await this.buildIssuerMetadata.execute(
            tenantId,
            issuer,
        );
        const trust = {
            tenantId,
            trustStoreService: this.trustStoreService,
            x509ValidationService: this.x509ValidationService,
        };
        const checkStatus = (
            keyAttestationJwt: string,
            provider: AttestationProofTrust,
        ) =>
            this.checkStatus(
                tenantId,
                keyAttestationJwt,
                provider,
                statusCheckMode,
            );
        return {
            verify: async (
                proof: string,
                type: IssuanceProofType,
            ): Promise<VerifiedCredentialProof> => {
                const expectedNonce = decodeJwt(proof).nonce as string;
                if (type === "jwt") {
                    const verified =
                        await issuer.verifyCredentialRequestJwtProof({
                            expectedNonce,
                            issuerMetadata,
                            jwt: proof,
                        });
                    // The library verified the key attestation signature and
                    // that the proof is signed with one of the attested keys.
                    const provider = await validateJwtProofAttestationTrust(
                        proof,
                        trustLists,
                        trust,
                    );
                    const walletUnit = provider
                        ? await checkStatus(
                              provider.keyAttestationJwt,
                              provider,
                          )
                        : undefined;
                    return {
                        holderKeys: [verified.signer.publicJwk],
                        keyAttestation: verified.keyAttestation
                            ? toVerifiedKeyAttestation(
                                  verified.keyAttestation.payload,
                                  walletUnit,
                              )
                            : undefined,
                    };
                }
                const verified =
                    await issuer.verifyCredentialRequestAttestationProof({
                        expectedNonce,
                        issuerMetadata,
                        keyAttestationJwt: proof,
                    });
                const provider = await validateAttestationProofTrust(
                    proof,
                    trustLists,
                    trust,
                );
                const keyAttestation = toVerifiedKeyAttestation(
                    verified.payload,
                    await checkStatus(proof, provider),
                );
                return {
                    holderKeys: keyAttestation.attestedKeys,
                    keyAttestation,
                };
            },
        };
    }

    /**
     * Check the status of a key attestation whose provider is trusted.
     * @returns The attestation's status list reference and `x5c`, when it
     * has a reference
     * @throws InvalidCredentialProof when the attestation is revoked or
     * suspended, or the check failed and the mode does not tolerate it; the
     * reason is logged
     */
    private async checkStatus(
        tenantId: string,
        keyAttestationJwt: string,
        provider: AttestationProofTrust,
        statusCheckMode: RevocationCheckMode,
    ): Promise<WalletUnitReference | undefined> {
        let entry: Awaited<
            ReturnType<WalletAttestationService["checkKeyAttestationStatus"]>
        >;
        try {
            entry = await this.walletAttestations.checkKeyAttestationStatus(
                tenantId,
                keyAttestationJwt,
                provider.matchedEntity,
                provider.trustStore,
                statusCheckMode,
            );
        } catch (error) {
            if (error instanceof AttestationStatusRejected) {
                throw new InvalidCredentialProof(error.message);
            }
            throw error;
        }
        if (!entry) return undefined;
        // Larger indexes do not fit the stored record; a list with that many
        // entries also exceeds the size a status list may inflate to.
        if (entry.idx > MAX_WALLET_UNIT_STATUS_INDEX) {
            throw new InvalidCredentialProof(
                "Key attestation status list index is too large",
            );
        }
        return {
            statusUri: entry.uri,
            statusIdx: entry.idx,
            certificates: provider.certificates,
        };
    }
}

function toVerifiedKeyAttestation(
    payload: {
        attested_keys: unknown[];
        key_storage?: string[];
        user_authentication?: string[];
    },
    walletUnit: WalletUnitReference | undefined,
): VerifiedKeyAttestation {
    return {
        attestedKeys: payload.attested_keys as Jwk[],
        keyStorage: payload.key_storage,
        userAuthentication: payload.user_authentication,
        ...(walletUnit && { walletUnit }),
    };
}
