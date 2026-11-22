/**
 * The status maintenance period of the attestations a credential follows
 * bounds its technical validity (TS3 1.5 section 2.4.3: "The technical
 * validity period of a PID SHALL end before the `client_status.exp` of the
 * WIA and the `key_storage_status.exp` of the KA"). Once the provider stops
 * maintaining an attestation's status, revocation chaining can no longer
 * revoke the credential, so the credential must have expired by then.
 */

/** Which attestation's maintenance period bounds the credential. */
export type MaintainedAttestation = "key" | "wallet";

/** The earliest end of the maintenance periods a credential follows. */
export interface MaintenancePeriodEnd {
    /** Epoch seconds; the credential must expire before it. */
    end: number;
    attestation: MaintainedAttestation;
}

/**
 * The maintenance period would leave the credential no validity: it has
 * ended, or ends before the credential could be valid for a second.
 */
export class CredentialLifetimeExhausted extends Error {
    constructor(readonly attestation: MaintainedAttestation) {
        super(
            attestation === "key"
                ? "The status maintenance period of the key attestation (key_storage_status.exp) leaves the credential no validity"
                : "The status maintenance period of the wallet attestation (client_status.exp) leaves the credential no validity",
        );
        this.name = "CredentialLifetimeExhausted";
    }
}

/**
 * The end of the maintenance periods that bound a credential, or undefined
 * when nothing bounds it. Only a configuration with `revokeWithWalletUnit`
 * follows its attestations after issuance; for the others, TS3 1.5 section
 * 2.4.3 lets the issuer choose the validity independently.
 *
 * @param keyAttestation The key attestation the credential follows
 * @param walletAttestation The wallet attestation it follows
 */
export function maintenancePeriodEnd(
    revokeWithWalletUnit: boolean | undefined,
    keyAttestation: { maintainedUntil?: number } | undefined,
    walletAttestation: { maintainedUntil?: number } | null | undefined,
): MaintenancePeriodEnd | undefined {
    if (!revokeWithWalletUnit) return undefined;
    const ends: MaintenancePeriodEnd[] = [];
    if (keyAttestation?.maintainedUntil !== undefined)
        ends.push({ end: keyAttestation.maintainedUntil, attestation: "key" });
    if (walletAttestation?.maintainedUntil !== undefined)
        ends.push({
            end: walletAttestation.maintainedUntil,
            attestation: "wallet",
        });
    return ends.reduce<MaintenancePeriodEnd | undefined>(
        (earliest, candidate) =>
            !earliest || candidate.end < earliest.end ? candidate : earliest,
        undefined,
    );
}

/**
 * The latest expiry a credential may have: one second before the end of the
 * maintenance period, so that it ends before it.
 *
 * @throws CredentialLifetimeExhausted when that is not after `now`
 */
function latestCredentialExpiry(
    bound: MaintenancePeriodEnd,
    nowSeconds = Math.floor(Date.now() / 1000),
): number {
    const latest = Math.floor(bound.end) - 1;
    if (latest <= nowSeconds)
        throw new CredentialLifetimeExhausted(bound.attestation);
    return latest;
}

/**
 * @throws CredentialLifetimeExhausted when the maintenance period leaves no
 * validity
 */
export function assertMaintenancePeriodOpen(
    bound: MaintenancePeriodEnd,
    nowSeconds = Math.floor(Date.now() / 1000),
): void {
    latestCredentialExpiry(bound, nowSeconds);
}

/**
 * A credential's expiry within its maintenance period bound.
 *
 * @param expiresAt The expiry the configuration gives, epoch seconds;
 * undefined for a credential without expiry, which then gets the bound
 * @returns The expiry to issue, undefined only without bound and expiry
 * @throws CredentialLifetimeExhausted when the bound leaves no validity
 */
export function boundCredentialExpiry(
    expiresAt: number | undefined,
    bound: MaintenancePeriodEnd | undefined,
    nowSeconds = Math.floor(Date.now() / 1000),
): number | undefined {
    if (!bound) return expiresAt;
    const latest = latestCredentialExpiry(bound, nowSeconds);
    return expiresAt === undefined ? latest : Math.min(expiresAt, latest);
}
