import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
    KEY_CHAIN_REFERENCE_KINDS,
    type KeyChainReferenceKind,
} from "../domain/key-chain-reference.js";

/** A configuration of the tenant that names the key chain. */
export class KeyChainReferenceDto {
    @ApiProperty({
        enum: KEY_CHAIN_REFERENCE_KINDS,
        description: "Kind of configuration that names the key chain.",
    })
    kind!: KeyChainReferenceKind;

    @ApiPropertyOptional({
        description:
            "ID of the configuration. Absent for the tenant's default key chains and the issuance configuration, of which a tenant has one each, and for configurations the caller may not read.",
    })
    id?: string;

    @ApiPropertyOptional({
        description:
            "Description of the configuration; absent for configurations the caller may not read.",
    })
    description?: string;
}

/** Body of the 409 response when a key chain that is still named is deleted. */
export class KeyChainInUseDto {
    @ApiProperty({ description: "HTTP status code.", example: 409 })
    statusCode!: number;

    @ApiProperty({
        description: "Time of the response.",
        example: "2026-10-17T12:00:00.000Z",
    })
    timestamp!: string;

    @ApiProperty({
        description: "Path of the request.",
        example: "/api/key-chain/pid-signing",
    })
    path!: string;

    @ApiProperty({
        enum: ["KEY_CHAIN_IN_USE"],
        description: "Configurations still name the key chain.",
    })
    code!: "KEY_CHAIN_IN_USE";

    @ApiProperty({
        description:
            "Names the configurations the caller may read and counts the others.",
        example:
            'Key chain "pid-signing" is still used by the issuance configuration and 1 credential config ("pid"). Remove these references before deleting the key chain.',
    })
    message!: string;

    @ApiProperty({ type: [KeyChainReferenceDto] })
    references!: KeyChainReferenceDto[];
}
