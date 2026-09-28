import {
    type CredentialVerifierFormat,
    UnsupportedCredentialVerifierFormat,
} from "../domain/credential-verifier-format.js";

export class CredentialVerifierFormatRegistry {
    private readonly formats: Map<string, CredentialVerifierFormat>;

    constructor(formats: CredentialVerifierFormat[]) {
        this.formats = new Map(
            formats.map((format) => [format.format, format]),
        );
    }

    resolve(format: string): CredentialVerifierFormat {
        const verifier = this.formats.get(format);
        if (!verifier) throw new UnsupportedCredentialVerifierFormat(format);
        return verifier;
    }
}
