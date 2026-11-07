import {
    ServiceTypeIdentifiers,
    type TrustedEntity,
    type TrustedEntityServiceCert,
} from "../types.js";

/*
 * Which certificates of a trusted entity may sign the status lists of the
 * credentials and attestations it issues: the revocation services paired with
 * the matched service by profile (ETSI TS 119 602), or else the matched
 * certificate itself.
 */

/**
 * The revocation service type that belongs to a matched issuance service:
 * `PID/Issuance` pairs with `PID/Revocation`, `PubEAA/Issuance` with
 * `PubEAA/Revocation`, and a wallet solution service with
 * `WalletSolution/Revocation`, as in the profiles of ETSI TS 119 602.
 */
function pairedRevocationServiceType(
    matchedServiceType: string | undefined,
): string | undefined {
    if (matchedServiceType === ServiceTypeIdentifiers.WalletSolution) {
        return ServiceTypeIdentifiers.WalletSolutionRevocation;
    }
    return matchedServiceType?.endsWith("/Issuance")
        ? `${matchedServiceType.slice(0, -"/Issuance".length)}/Revocation`
        : undefined;
}

/**
 * The revocation services of a TrustedEntity paired with its matched service:
 * every service of the paired revocation type, or, when the entity has none,
 * its `EAA/Revocation` services, the only ones read before. All returned
 * services have the same type. The status list of a credential or attestation
 * matched with that service must be signed under one of them, see
 * {@link getStatusListSigners}.
 */
export function getRevocationServices(
    entity: TrustedEntity,
    matchedServiceType?: string,
): TrustedEntityServiceCert[] {
    const ofType = (type: string) =>
        entity.services.filter((s) => s.serviceTypeIdentifier === type);
    const pairedType = pairedRevocationServiceType(matchedServiceType);
    const paired = pairedType ? ofType(pairedType) : [];
    return paired.length > 0
        ? paired
        : ofType(ServiceTypeIdentifiers.EaaRevocation);
}

/**
 * The services that may sign the status list of a credential or attestation
 * whose certificate matched `matchedService` of `entity`: the revocation
 * services paired with it ({@link getRevocationServices}), or, when the
 * entity lists none, the matched service itself. Any other signer, even one of
 * the same entity, could serve a list in which a revoked credential is valid.
 */
export function getStatusListSigners(
    entity: TrustedEntity,
    matchedService: TrustedEntityServiceCert,
): TrustedEntityServiceCert[] {
    const revocationServices = getRevocationServices(
        entity,
        matchedService.serviceTypeIdentifier,
    );
    return revocationServices.length > 0
        ? revocationServices
        : [matchedService];
}

/**
 * The first revocation certificate of a TrustedEntity for a matched service,
 * see {@link getRevocationServices}. It names the revocation certificate in
 * the verification result; no trust decision depends on it.
 */
export function getRevocationCert(
    entity: TrustedEntity,
    matchedServiceType?: string,
): TrustedEntityServiceCert | undefined {
    return getRevocationServices(entity, matchedServiceType)[0];
}
