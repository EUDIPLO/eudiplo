import type { CredentialIssuerFormat } from "../domain/credential-issuer-format.js";
import { UnsupportedCredentialFormat } from "../domain/credential-issuer-format.js";

export class CredentialIssuerFormatRegistry {
    private readonly formats: Map<string, CredentialIssuerFormat>;

    constructor(formats: CredentialIssuerFormat[]) {
        this.formats = new Map(
            formats.map((format) => [format.format, format]),
        );
    }

    resolve(format: string): CredentialIssuerFormat {
        const issuer = this.formats.get(format);
        if (!issuer) throw new UnsupportedCredentialFormat(format);
        return issuer;
    }
}
