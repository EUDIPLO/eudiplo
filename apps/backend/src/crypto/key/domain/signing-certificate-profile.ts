import { AsnConvert } from "@peculiar/asn1-schema";
import {
    Name as AsnName,
    type AttributeTypeAndValue,
    RelativeDistinguishedName,
} from "@peculiar/asn1-x509";
import * as x509 from "@peculiar/x509";
import { KeyUsageType } from "../types/key-usage-type.js";

/**
 * Extended key usage of an mDL document signer certificate
 * (ISO/IEC 18013-5 Annex B.1.4).
 */
export const MDL_DOCUMENT_SIGNER_EKU = "1.0.18013.5.1.2";

/**
 * Profile of a key chain's signing certificate:
 * - `documentSigner`: the ISO/IEC 18013-5 Annex B.1.4 document signer
 *   profile, for key chains that sign mdoc credentials. It adds the
 *   critical mDL document signer extended key usage and an
 *   IssuerAlternativeName.
 * - `default`: no extended key usage, as for access, status list, trust
 *   list and federation certificates, which other profiles govern.
 */
export type SigningCertificateProfile = "documentSigner" | "default";

/**
 * The signing certificate profile of a key chain. Attestation key chains
 * sign mdoc credentials (and SD-JWT VCs, whose specifications define no
 * extended key usage), so their certificates follow the document signer
 * profile; no other usage type signs mdocs.
 */
export function signingCertificateProfile(
    usageType: KeyUsageType,
): SigningCertificateProfile {
    return usageType === KeyUsageType.Attestation
        ? "documentSigner"
        : "default";
}

/** countryName and stateOrProvinceName (RFC 5280 4.1.2.4). */
const ID_AT_COUNTRY_NAME = "2.5.4.6";
const ID_AT_STATE_OR_PROVINCE_NAME = "2.5.4.8";

/**
 * Subject of a document signer: countryName and stateOrProvinceName of the
 * issuing CA's subject, which ISO/IEC 18013-5 Annex B.1.4 requires to match,
 * then the common name. The CA's attribute values are copied with their
 * encoding, so readers that compare them byte for byte see the same value.
 * Falls back to C=DE when the CA names no country.
 */
export function documentSignerSubject(
    caSubject: x509.Name,
    commonName: string,
): x509.Name {
    const caAttributes = AsnConvert.parse(
        caSubject.toArrayBuffer(),
        AsnName,
    ).flatMap((rdn) => [...rdn]);
    const attribute = (type: string): AttributeTypeAndValue | undefined =>
        caAttributes.find((a) => a.type === type);
    const country = attribute(ID_AT_COUNTRY_NAME) ?? attributesOf("C=DE").at(0);
    const state = attribute(ID_AT_STATE_OR_PROVINCE_NAME);
    const rdns = [country, state, ...attributesOf([{ CN: [commonName] }])]
        .filter((a): a is AttributeTypeAndValue => a !== undefined)
        .map((a) => new RelativeDistinguishedName([a]));
    return new x509.Name(AsnConvert.serialize(new AsnName(rdns)));
}

/** The attributes of a name built by `@peculiar/x509`, in order. */
function attributesOf(name: string | x509.JsonName): AttributeTypeAndValue[] {
    return AsnConvert.parse(
        new x509.Name(name).toArrayBuffer(),
        AsnName,
    ).flatMap((rdn) => [...rdn]);
}
