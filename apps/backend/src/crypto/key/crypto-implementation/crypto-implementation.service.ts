import { Injectable } from "@nestjs/common";
import { ES256, ES384, ES512 } from "@owf/crypto";
import { CredentialFormat } from "../../../issuer/configuration/credentials/entities/credential.entity.js";
import {
    KMS_SIGNING_ALGS,
    type KmsSigningAlg,
    SIGNING_ALG_SPECS,
    signingAlgForCurve,
} from "../domain/signing-algs.js";
import { CryptoImplementation } from "./crypto-implementation.js";

/**
 * JOSE algorithm names used for SD-JWT VC
 */
export type JoseAlgorithm = KmsSigningAlg;

/**
 * COSE algorithm identifiers used for mDOC (ISO 18013-5): classic
 * (RFC 9053) and fully-specified (RFC 9864) ones.
 * @see https://www.rfc-editor.org/rfc/rfc9864.html
 */
export type CoseAlgorithm = number;

const CRYPTO_IMPLEMENTATIONS: Record<KmsSigningAlg, CryptoImplementation> = {
    ES256,
    ES384,
    ES512,
};

@Injectable()
export class CryptoImplementationService {
    /**
     * Algorithms EUDIPLO accepts in signatures of wallets and other issuers
     * (proofs, key binding JWTs, presented credentials), in the identifiers
     * of the credential format.
     * - For SD-JWT VC: JOSE algorithm names (ES256, ES384, ES512)
     * - For mDOC: the classic COSE algorithm identifiers (-7, -35, -36) that
     *   an IssuerAuth may carry, see {@link getMdocDeviceAuthAlgs} for
     *   device signatures
     * @param credentialFormat The credential format
     * @returns Array of algorithm identifiers appropriate for the format
     */
    getAlgs(
        credentialFormat: CredentialFormat,
    ): (JoseAlgorithm | CoseAlgorithm)[] {
        return this.toFormatAlgs(credentialFormat, KMS_SIGNING_ALGS);
    }

    /**
     * COSE algorithms EUDIPLO accepts in the DeviceSignature of a presented
     * mDOC: the classic identifiers and the fully-specified ones of RFC 9864
     * (-9, -51, -52), which name the same curve and hash. Since @owf/cose
     * 0.8 an IssuerAuth with a fully-specified identifier verifies as well,
     * but `issuerauth_alg_values` still lists only the classic ones (see
     * {@link getAlgs}).
     */
    getMdocDeviceAuthAlgs(): CoseAlgorithm[] {
        return [
            ...(this.getAlgs(CredentialFormat.MSO_MDOC) as CoseAlgorithm[]),
            ...KMS_SIGNING_ALGS.map(
                (alg) => SIGNING_ALG_SPECS[alg].fullySpecifiedCoseAlg,
            ),
        ];
    }

    /**
     * The identifier of one signing algorithm in a credential format, for
     * `credential_signing_alg_values_supported` of a credential signed with a
     * key of that algorithm. For mDOC it is the classic COSE identifier, the
     * one EUDIPLO places in the IssuerAuth `alg` header.
     */
    getSigningAlgs(
        credentialFormat: CredentialFormat,
        alg: KmsSigningAlg,
    ): (JoseAlgorithm | CoseAlgorithm)[] {
        return this.toFormatAlgs(credentialFormat, [alg]);
    }

    private toFormatAlgs(
        credentialFormat: CredentialFormat,
        joseAlgs: readonly JoseAlgorithm[],
    ): (JoseAlgorithm | CoseAlgorithm)[] {
        if (credentialFormat === CredentialFormat.MSO_MDOC) {
            return joseAlgs.map((alg) => SIGNING_ALG_SPECS[alg].coseAlg);
        }

        // SD-JWT VC and the default use JOSE algorithms
        return [...joseAlgs];
    }

    /**
     * Returns the crypto implementation directly based on the JWK properties.
     * Supports EC keys on P-256 (ES256), P-384 (ES384) and P-521 (ES512).
     * @param jwk - JSON Web Key
     * @returns The appropriate crypto implementation
     * @throws Error if the crypto implementation cannot be determined from the JWK
     */
    getCryptoFromJwk(jwk: JsonWebKey): CryptoImplementation {
        if (!jwk || typeof jwk !== "object") {
            throw new Error("Invalid JWK provided");
        }

        const alg = jwk.kty === "EC" ? signingAlgForCurve(jwk.crv) : undefined;
        if (alg) {
            return CRYPTO_IMPLEMENTATIONS[alg];
        }

        throw new Error(
            `Unable to determine crypto implementation from JWK: unsupported key type or curve`,
        );
    }
}
