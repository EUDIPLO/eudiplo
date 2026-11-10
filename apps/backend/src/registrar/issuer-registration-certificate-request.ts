import type {
    ProvidedAttestation,
    RegistrationCertificateCreation,
} from "./generated/types.gen.js";

/** A credential type an issuer provides, with the format it is issued in. */
export interface IssuerCredentialType {
    format: "dc+sd-jwt" | "mso_mdoc";
    /** SD-JWT VC `vct` or mdoc `docType`. */
    type: string;
}

/**
 * Registrar request body for a generated issuer registration certificate.
 *
 * The types go in `custom_provides_attestations`, which the registrar takes as
 * given: an issuer may provide credential types that have no published schema
 * in the registrar's catalog, which `provides_attestations` requires.
 * `provides_attestations` is set to an empty list so a value stored in the
 * registrar's `registrationCertificateDefaults` does not reach the request.
 */
export function issuerRegistrationCertificateBody(
    settings: { privacyPolicy?: string; supportUri?: string },
    types: IssuerCredentialType[],
): Pick<
    RegistrationCertificateCreation,
    "provides_attestations" | "custom_provides_attestations"
> &
    Partial<
        Pick<RegistrationCertificateCreation, "privacy_policy" | "support_uri">
    > {
    return {
        provides_attestations: [],
        custom_provides_attestations: types.map(toProvidedAttestation),
        ...(settings.privacyPolicy
            ? { privacy_policy: settings.privacyPolicy }
            : {}),
        ...(settings.supportUri ? { support_uri: settings.supportUri } : {}),
    };
}

function toProvidedAttestation({
    format,
    type,
}: IssuerCredentialType): ProvidedAttestation {
    return format === "mso_mdoc"
        ? { format, meta: { doctype_value: type } }
        : { format, meta: { vct_values: [type] } };
}
