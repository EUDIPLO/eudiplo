import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

/** A configuration of the tenant that names the attribute provider. */
export class AttributeProviderReferenceDto {
    @ApiProperty({
        enum: ["CredentialConfig"],
        description: "Kind of configuration that names the attribute provider.",
    })
    kind!: "CredentialConfig";

    @ApiProperty({ description: "ID of the credential config." })
    id!: string;

    @ApiPropertyOptional({
        description: "Description of the credential config.",
    })
    description?: string;
}

/** Body of the 409 response when an attribute provider that is still named is deleted. */
export class AttributeProviderInUseDto {
    @ApiProperty({ description: "HTTP status code.", example: 409 })
    statusCode!: number;

    @ApiProperty({
        description: "Time of the response.",
        example: "2026-11-19T12:00:00.000Z",
    })
    timestamp!: string;

    @ApiProperty({
        description: "Path of the request.",
        example: "/api/issuer/attribute-providers/crm",
    })
    path!: string;

    @ApiProperty({
        enum: ["ATTRIBUTE_PROVIDER_IN_USE"],
        description: "Credential configs still name the attribute provider.",
    })
    code!: "ATTRIBUTE_PROVIDER_IN_USE";

    @ApiProperty({
        description: "Names the credential configs that use the provider.",
        example:
            'Attribute provider "crm" is still used by 1 credential config ("pid"). Remove these references before deleting the attribute provider.',
    })
    message!: string;

    @ApiProperty({ type: [AttributeProviderReferenceDto] })
    references!: AttributeProviderReferenceDto[];
}
