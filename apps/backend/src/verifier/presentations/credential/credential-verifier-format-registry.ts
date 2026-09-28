import type {
    CredentialVerifierFormat,
    MdocCredentialVerifier,
    SdJwtCredentialVerifier,
} from "./credential-verifier-format.js";

export class CredentialVerifierFormatRegistry {
    private readonly formats: Map<string, CredentialVerifierFormat>;

    constructor(formats: CredentialVerifierFormat[]) {
        this.formats = new Map(
            formats.map((format) => [format.format, format]),
        );
    }

    resolve(format: "mso_mdoc"): MdocCredentialVerifier;
    resolve(format: "dc+sd-jwt"): SdJwtCredentialVerifier;
    resolve(format: string): CredentialVerifierFormat {
        const verifier = this.formats.get(format);
        if (!verifier) {
            throw new Error(
                `Unsupported credential verifier format '${format}'`,
            );
        }
        return verifier;
    }
}
