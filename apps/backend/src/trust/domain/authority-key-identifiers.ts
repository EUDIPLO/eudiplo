import * as x509 from "@peculiar/x509";
import {
    ServiceTypeIdentifiers,
    serviceTypeMatches,
    type TrustedEntity,
} from "../types.js";

/** Services whose certificates identify credential issuers, as in verification. */
const credentialIssuanceServiceTypes = [
    ServiceTypeIdentifiers.PIDIssuance,
    ServiceTypeIdentifiers.EaaIssuance,
];

/** DCQL `aki` values for the credential issuers of a trust list. */
export interface IssuerAuthorityKeyIdentifiers {
    /** Base64url-encoded key identifiers, de-duplicated. */
    values: string[];
    /**
     * False when an issuance certificate yields no value a credential's chain
     * can carry, so `values` alone would not match all listed issuers.
     */
    complete: boolean;
}

/**
 * DCQL `aki` values (OpenID4VP 1.0 §6.1.1.1) for the credential issuers of a
 * trust list. A credential matches when a certificate in its chain carries one
 * of the values as the KeyIdentifier of its AuthorityKeyIdentifier.
 *
 * Every PID/EAA issuance certificate contributes its Subject Key Identifier,
 * which certificates issued below it carry as AKI. A listed certificate that is
 * not a CA is pinned as the signing certificate itself, so its own AKI is added
 * as well. A certificate that cannot be parsed, a CA without SKI, or a pinned
 * certificate without AKI (e.g. self-signed) marks the result incomplete.
 */
export function credentialIssuerAuthorityKeyIdentifiers(
    entities: TrustedEntity[],
): IssuerAuthorityKeyIdentifiers {
    const values = new Set<string>();
    let complete = true;
    for (const entity of entities) {
        for (const service of entity.services) {
            const isIssuance = credentialIssuanceServiceTypes.some((type) =>
                serviceTypeMatches(service.serviceTypeIdentifier, type),
            );
            if (!isIssuance) continue;

            const cert = parseCertificate(service.certValue);
            if (!cert) {
                complete = false;
                continue;
            }

            const ski = keyIdentifier(
                cert.getExtension(x509.SubjectKeyIdentifierExtension)?.keyId,
            );
            if (ski) values.add(ski);
            if (cert.getExtension(x509.BasicConstraintsExtension)?.ca) {
                complete &&= ski !== undefined;
                continue;
            }

            const aki = keyIdentifier(
                cert.getExtension(x509.AuthorityKeyIdentifierExtension)?.keyId,
            );
            if (aki) values.add(aki);
            complete &&= aki !== undefined;
        }
    }
    return { values: [...values], complete };
}

/** Trust lists carry base64 DER; PEM is accepted for externally supplied values. */
function parseCertificate(value: string): x509.X509Certificate | undefined {
    try {
        return new x509.X509Certificate(
            value.includes("-----BEGIN")
                ? value
                : Buffer.from(value.replaceAll(/\s/g, ""), "base64"),
        );
    } catch {
        return undefined;
    }
}

/** @peculiar/x509 exposes key identifiers as hex strings. */
function keyIdentifier(hexKeyId: string | undefined): string | undefined {
    return hexKeyId
        ? Buffer.from(hexKeyId, "hex").toString("base64url")
        : undefined;
}
