import * as x509 from "@peculiar/x509";

/** Longer than any distinguished name a CA certifies. */
export const MAX_SUBJECT_LENGTH = 1024;

/** A subject that cannot be the subject of a certificate signing request. */
export class InvalidSubjectError extends Error {}

/**
 * The subject of a certificate signing request as a distinguished name, such
 * as `C=DE, O=Example, CN=Example Verifier`, or undefined for an empty one,
 * which means the default subject. The attributes are encoded in the order
 * written, the order in which certificates list them, not reversed as in
 * RFC 4514. Throws {@link InvalidSubjectError} for a
 * subject that is not one string, is too long, is not a distinguished name, or has an attribute
 * without value. The parser is lenient: it reads text without `=` as an empty
 * name and `CN=` as an empty value, so both are checked here.
 */
export function parseSubject(subject?: unknown): x509.Name | undefined {
    if (subject === undefined) return undefined;
    // A query parameter given twice arrives as an array.
    if (typeof subject !== "string") {
        throw new InvalidSubjectError("Give the subject once, as one string.");
    }
    const trimmed = subject.trim();
    if (!trimmed) return undefined;
    // The parser's time grows with the square of the length.
    if (trimmed.length > MAX_SUBJECT_LENGTH) {
        throw new InvalidSubjectError(
            `The subject must not be longer than ${MAX_SUBJECT_LENGTH} characters.`,
        );
    }
    let name: x509.Name;
    try {
        name = new x509.Name(trimmed);
    } catch {
        throw notADistinguishedName(trimmed);
    }
    const attributes = name.toJSON();
    const hasEmptyValue = attributes.some((rdn) =>
        Object.values(rdn).some((values) =>
            values.some((value) => !String(value).trim()),
        ),
    );
    if (attributes.length === 0 || hasEmptyValue) {
        throw notADistinguishedName(trimmed);
    }
    return name;
}

function notADistinguishedName(subject: string): InvalidSubjectError {
    return new InvalidSubjectError(
        `The subject "${subject}" is not a distinguished name with a value for each attribute, for example C=DE, O=Example, CN=Example Verifier.`,
    );
}
