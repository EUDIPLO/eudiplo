/** The configuration fields that revocation with the wallet unit depends on. */
export interface WalletUnitRevocationSettings {
    revokeWithWalletUnit?: boolean | null;
    statusManagement?: boolean | null;
    config?: { keyAttestationsRequired?: object | null } | null;
}

const REVOKE_WITH_WALLET_UNIT_REQUIRES_STATUS_MANAGEMENT =
    "statusManagement must be enabled when revokeWithWalletUnit is enabled.";

const REVOKE_WITH_WALLET_UNIT_REQUIRES_KEY_ATTESTATIONS =
    "config.keyAttestationsRequired must be set when revokeWithWalletUnit is enabled.";

/**
 * Why revocation with the wallet unit cannot be enforced, as path and
 * message; empty when it is off or can be enforced. Revoking a credential
 * needs its status list entry, and only a required key attestation tells
 * which wallet unit the credential belongs to.
 */
export function walletUnitRevocationProblems(
    settings: WalletUnitRevocationSettings,
): { path: (string | number)[]; message: string }[] {
    if (settings.revokeWithWalletUnit !== true) return [];
    const problems: { path: (string | number)[]; message: string }[] = [];
    if (!settings.statusManagement) {
        problems.push({
            path: ["statusManagement"],
            message: REVOKE_WITH_WALLET_UNIT_REQUIRES_STATUS_MANAGEMENT,
        });
    }
    if (!settings.config?.keyAttestationsRequired) {
        problems.push({
            path: ["config", "keyAttestationsRequired"],
            message: REVOKE_WITH_WALLET_UNIT_REQUIRES_KEY_ATTESTATIONS,
        });
    }
    return problems;
}
