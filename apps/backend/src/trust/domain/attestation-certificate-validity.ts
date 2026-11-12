import {
    certificateValidityAt,
    formatCertificateDate,
    type ValidityPeriod,
} from "../../shared/utils/certificate-validity.util.js";

/** Where a certificate sits in the path of a wallet or key attestation. */
export type AttestationCertificatePosition =
    | "signing"
    | "intermediate"
    | "trust list";

const positionNames: Record<AttestationCertificatePosition, string> = {
    signing: "Signing certificate",
    intermediate: "Intermediate certificate",
    "trust list": "Trust list certificate",
};

/**
 * A certificate of a wallet or key attestation's path, from the certificate
 * that signs the attestation to the one listed in the wallet-provider trust
 * list, is outside its validity period at the time of the check.
 *
 * The message names the certificate by its place in the path and gives its
 * period, not its subject: it reaches the wallet as an OAuth
 * `error_description`, which must not carry characters a subject may hold.
 */
export class AttestationCertificateNotValid extends Error {
    constructor(
        readonly position: AttestationCertificatePosition,
        readonly validity: "expired" | "not_yet_valid",
        readonly period: ValidityPeriod,
        readonly checkedAt: Date,
    ) {
        const checked = `checked at ${formatCertificateDate(checkedAt)}`;
        super(
            validity === "expired"
                ? `${positionNames[position]} has expired (notAfter ${formatCertificateDate(period.notAfter)}, ${checked})`
                : `${positionNames[position]} is not yet valid (notBefore ${formatCertificateDate(period.notBefore)}, ${checked})`,
        );
        this.name = "AttestationCertificateNotValid";
    }
}

/**
 * Check the validity period of every certificate an attestation's trust
 * rests on: the signing certificate, the intermediates and the certificate
 * listed in the trust list, both ends of each period included
 * ({@link certificateValidityAt}). Certificates above the listed one, such
 * as the issuer of a pinned signing certificate, are not part of the trust
 * decision and are not checked.
 * @param path The certificate path, signing certificate first
 * @param listedIndex Index in `path` of the certificate listed in the trust
 * list: 0 for a pinned signing certificate, the last for a CA
 * @param now The time to check at
 * @throws AttestationCertificateNotValid for the first certificate outside
 * its period, from the signing certificate up
 */
export function assertAttestationPathValidAt(
    path: readonly ValidityPeriod[],
    listedIndex: number,
    now: Date,
): void {
    for (let index = 0; index <= listedIndex; index++) {
        const { notBefore, notAfter } = path[index];
        const validity = certificateValidityAt({ notBefore, notAfter }, now);
        if (validity === "valid") continue;
        let position: AttestationCertificatePosition = "intermediate";
        if (index === 0) position = "signing";
        else if (index === listedIndex) position = "trust list";
        throw new AttestationCertificateNotValid(
            position,
            validity,
            { notBefore, notAfter },
            now,
        );
    }
}
