/** The configuration fields that decide whether a wallet sends key proofs. */
export interface KeyProofSettings {
    keyBinding?: boolean | null;
    config: {
        format: string;
        keyAttestationsRequired?: object | null;
    };
}

/**
 * Whether a credential request for this configuration must carry key proofs
 * (OpenID4VCI 1.0 Section 8.2), and so whether its metadata publishes
 * `cryptographic_binding_methods_supported` and `proof_types_supported`
 * (Section 12.2.4: both present when key binding is required, omitted
 * otherwise).
 *
 * - An mDOC is always bound to its device key (ISO/IEC 18013-5): `keyBinding`
 *   does not apply to it.
 * - An SD-JWT VC needs proofs when `keyBinding` is true, so its `cnf` names
 *   the proven key.
 * - A required key attestation can only arrive in a key proof, so
 *   `config.keyAttestationsRequired` keeps proofs required even with
 *   `keyBinding` off: the wallet unit is still attested (and recorded for
 *   `revokeWithWalletUnit`), and the SD-JWT VC still carries no `cnf`.
 *
 * Without proofs, one credential bound to no key is issued per request.
 */
export function requiresKeyProof(settings: KeyProofSettings): boolean {
    return (
        settings.config.format === "mso_mdoc" ||
        settings.keyBinding === true ||
        Boolean(settings.config.keyAttestationsRequired)
    );
}
