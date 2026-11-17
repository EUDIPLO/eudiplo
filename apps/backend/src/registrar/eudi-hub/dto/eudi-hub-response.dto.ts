import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

/** An organization at the EUDI Hub the token's user is assigned to. */
export class EudiHubOrganizationDto {
    @ApiProperty({
        description: "ID of the organization at the EUDI Hub",
        example: "01932c5a-9abc-7000-8000-000000000010",
    })
    id!: string;

    @ApiProperty({
        description: "Name of the organization",
        example: "Example Org",
    })
    name!: string;
}

/** An access certificate of the EUDI Hub stored in a key chain. */
export class EudiHubAccessCertificateDto {
    @ApiProperty({ description: "ID of the certificate at the EUDI Hub" })
    id!: string;

    @ApiProperty({
        description: "ID of the key chain that now holds the certificate",
    })
    certId!: string;

    @ApiProperty({ description: "The certificate in PEM format" })
    crt!: string;

    @ApiProperty({
        description: "EUDI Hub environment that issued the certificate",
        enum: ["sandbox", "live"],
    })
    environment!: "sandbox" | "live";

    @ApiPropertyOptional({
        description:
            "Client identifier the EUDI Hub derived from the certificate",
        example: "X509_hash:K7_l5RcjzCZ7eGL0DPcf",
    })
    clientId?: string;

    @ApiPropertyOptional({
        description: "When the certificate expires, as the EUDI Hub reports it",
        example: "2027-06-17T23:59:59Z",
    })
    expirationDate?: string;
}

class EudiHubTextDto {
    @ApiProperty({ example: "en" })
    lang!: string;

    @ApiProperty()
    content!: string;
}

class EudiHubIdentifierDto {
    @ApiProperty({ example: "http://data.europa.eu/eudi/id/EUID" })
    type!: string;

    @ApiProperty({ example: "DE/HRB123456B" })
    value!: string;
}

class EudiHubServiceDescriptionDto {
    @ApiProperty({ description: "Technical name of the service description" })
    name!: string;

    @ApiProperty({ type: [EudiHubTextDto] })
    descriptions!: EudiHubTextDto[];
}

/** What the EUDI Hub knows about an organization that a registration certificate needs. */
export class EudiHubOrganizationDetailsDto {
    @ApiProperty({ description: "ID of the organization at the EUDI Hub" })
    id!: string;

    @ApiProperty({ description: "Trade name, else legal name" })
    name!: string;

    @ApiProperty({
        type: [EudiHubIdentifierDto],
        description: "Official identifiers of the organization",
    })
    identifiers!: EudiHubIdentifierDto[];

    @ApiProperty({ type: [EudiHubServiceDescriptionDto] })
    serviceDescriptions!: EudiHubServiceDescriptionDto[];

    @ApiProperty({ type: [String] })
    privacyPolicyUris!: string[];

    @ApiProperty({ type: [String] })
    supportUris!: string[];

    @ApiProperty({ type: [String] })
    infoUris!: string[];
}

/** A registration certificate of the EUDI Hub stored in a configuration. */
export class EudiHubRegistrationCertificateDto {
    @ApiProperty({ description: "ID of the certificate at the EUDI Hub" })
    id!: string;

    @ApiProperty({ enum: ["sandbox", "live"] })
    environment!: "sandbox" | "live";

    @ApiPropertyOptional({
        description: "When the certificate expires, as the EUDI Hub reports it",
    })
    expirationDate?: string;

    @ApiPropertyOptional({
        description:
            "Credential request the certificate was issued for (verifier)",
    })
    credentialRequestId?: string;

    @ApiPropertyOptional({
        description:
            "Whether an existing credential request with the same credentials, purpose and privacy policy was used",
    })
    reusedCredentialRequest?: boolean;

    @ApiPropertyOptional({
        type: [String],
        description:
            "Credential issuances the certificate was issued for (issuer)",
    })
    credentialIssuanceIds?: string[];
}
