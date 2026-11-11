/** A certificate's validity period, as X.509 certificate parsers expose it. */
export interface ValidityPeriod {
    notBefore: Date;
    notAfter: Date;
}

/**
 * Where `now` lies relative to a certificate's validity period. Both ends
 * belong to the period (RFC 5280 §4.1.2.5: "from notBefore through notAfter,
 * inclusive"). A date that is not a number puts `now` outside it.
 */
export function certificateValidityAt(
    period: ValidityPeriod,
    now: Date,
): "valid" | "not_yet_valid" | "expired" {
    if (!(period.notBefore.getTime() <= now.getTime())) {
        return "not_yet_valid";
    }
    if (!(now.getTime() <= period.notAfter.getTime())) {
        return "expired";
    }
    return "valid";
}
