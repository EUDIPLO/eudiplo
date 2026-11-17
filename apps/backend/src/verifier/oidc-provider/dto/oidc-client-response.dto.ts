import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import type { OidcClient, OidcClientSecret } from "../domain/oidc-client.js";

export class OidcClientScopeDto {
    @ApiProperty({ description: "Scope the client requests next to openid" })
    scope!: string;

    @ApiProperty({ description: "Presentation config behind the scope" })
    presentationConfigId!: string;
}

export class OidcSubjectClaimDto {
    @ApiProperty({ description: "Credential query (DCQL) ID" })
    credentialId!: string;

    @ApiProperty({ description: "Dot-separated path to the claim" })
    claim!: string;
}

/** A client secret without its value, which is only shown once. */
export class OidcClientSecretDto {
    @ApiProperty()
    id!: string;

    @ApiProperty({ type: String, format: "date-time" })
    createdAt!: string;

    @ApiPropertyOptional({ type: String, format: "date-time", nullable: true })
    expiresAt?: string | null;

    @ApiPropertyOptional({
        type: String,
        format: "date-time",
        nullable: true,
        description: "Last successful use, accurate to five minutes",
    })
    lastUsedAt?: string | null;
}

export class OidcClientResponseDto {
    @ApiProperty({ description: "The client_id" })
    id!: string;

    @ApiProperty()
    name!: string;

    @ApiProperty({ type: [String] })
    redirectUris!: string[];

    @ApiProperty({ enum: ["secure", "basic"] })
    profile!: "secure" | "basic";

    @ApiProperty({ type: [OidcClientScopeDto] })
    scopes!: OidcClientScopeDto[];

    @ApiProperty({ type: [OidcClientSecretDto] })
    secrets!: OidcClientSecretDto[];

    @ApiPropertyOptional({
        type: OidcSubjectClaimDto,
        nullable: true,
        description:
            "Claim whose hash becomes `sub`; null for a new `sub` per sign-in",
    })
    subject?: OidcSubjectClaimDto | null;

    @ApiPropertyOptional({
        type: String,
        nullable: true,
        description:
            "Credential query whose claims are also at the ID token's top level",
    })
    claimsFrom?: string | null;

    @ApiProperty({
        description:
            "Issuer of the tenant's OpenID Provider; discovery is at <issuer>/.well-known/openid-configuration",
    })
    issuer!: string;

    @ApiPropertyOptional({ type: String, format: "date-time" })
    createdAt?: string;

    @ApiPropertyOptional({ type: String, format: "date-time" })
    updatedAt?: string;
}

export class CreatedOidcClientResponseDto extends OidcClientResponseDto {
    @ApiProperty({
        description:
            "The client secret. It is returned only now and stored as a hash.",
    })
    clientSecret!: string;
}

export class CreatedOidcClientSecretResponseDto extends OidcClientSecretDto {
    @ApiProperty({
        description:
            "The client secret. It is returned only now and stored as a hash.",
    })
    clientSecret!: string;
}

export function toSecretDto(secret: OidcClientSecret): OidcClientSecretDto {
    return {
        id: secret.id,
        createdAt: secret.createdAt.toISOString(),
        expiresAt: secret.expiresAt?.toISOString() ?? null,
        lastUsedAt: secret.lastUsedAt?.toISOString() ?? null,
    };
}

export function toClientDto(
    client: OidcClient,
    issuer: string,
): OidcClientResponseDto {
    return {
        id: client.id,
        name: client.name,
        redirectUris: client.redirectUris,
        profile: client.profile,
        scopes: client.scopes,
        secrets: client.secrets.map(toSecretDto),
        subject: client.subject ?? null,
        claimsFrom: client.claimsFrom ?? null,
        issuer,
        createdAt: client.createdAt?.toISOString(),
        updatedAt: client.updatedAt?.toISOString(),
    };
}
