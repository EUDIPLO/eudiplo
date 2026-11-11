/**
 * Longest validity period of a PID without revocation information, in
 * seconds: ARF Annex 2 VCR_01 and VCR_01b require a PID valid for longer
 * to carry it.
 */
export const PID_MAX_VALIDITY_WITHOUT_STATUS_SECONDS = 24 * 60 * 60;

/**
 * Why a credential without status information leaves no reliable revocation
 * status, or `undefined` if it does not need any (ARF Annex 2 VCR_01,
 * VCR_01b, VCR_14).
 *
 * A credential is a PID when its certificate chain matches a certificate
 * listed with a PID issuance service of the trust lists; one verified without a trust list
 * (OpenID Federation, or no trusted authority) is not. A PID needs status
 * information when its validity period is longer than 24 hours, or cannot
 * be told because its start or end is missing. VCR_01 binds QEAA and PuB-EAA
 * providers too; their credentials without status information are left to
 * the relying party's policy (VCR_14), as for EAAs.
 *
 * @param input.pid Whether the credential is a PID
 * @param input.validFrom Start of the validity period, epoch seconds, if
 *   the credential states one
 * @param input.validUntil End of the validity period, epoch seconds, if
 *   the credential expires
 */
export function pidWithoutStatusProblem(input: {
    pid: boolean;
    validFrom: number | undefined;
    validUntil: number | undefined;
}): string | undefined {
    if (!input.pid) {
        return undefined;
    }
    if (
        input.validFrom !== undefined &&
        input.validUntil !== undefined &&
        input.validUntil - input.validFrom <=
            PID_MAX_VALIDITY_WITHOUT_STATUS_SECONDS
    ) {
        return undefined;
    }
    return "The PID carries no status information and its validity period is longer than 24 hours or unknown, so its revocation status could not be checked";
}
