import type { ValidityPeriod } from "../../src/shared/utils/certificate-validity.util.js";

/**
 * Validity periods for test certificates of wallet and key attestations, and
 * the start of the message that rejects a certificate outside its period
 * (`AttestationCertificateNotValid`).
 */

const hour = 3_600_000;

/** A period from an hour ago to an hour from now. */
export const currentPeriod = (): ValidityPeriod => ({
    notBefore: new Date(Date.now() - hour),
    notAfter: new Date(Date.now() + hour),
});

/** Periods that do not include the current time. */
export const periodsOutside = {
    expired: (): ValidityPeriod => ({
        notBefore: new Date(Date.now() - 2 * hour),
        notAfter: new Date(Date.now() - hour),
    }),
    "not yet valid": (): ValidityPeriod => ({
        notBefore: new Date(Date.now() + hour),
        notAfter: new Date(Date.now() + 2 * hour),
    }),
};

export type OutsideState = keyof typeof periodsOutside;

export const outsideStates = Object.keys(periodsOutside) as OutsideState[];

/**
 * The message for a certificate at `position` that is `state`, up to the
 * date it names.
 */
export function certificateFailure(
    position: "Signing" | "Intermediate" | "Trust list",
    state: OutsideState,
): string {
    return state === "expired"
        ? `${position} certificate has expired (notAfter `
        : `${position} certificate is not yet valid (notBefore `;
}
