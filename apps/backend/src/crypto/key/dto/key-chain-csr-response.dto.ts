import { ApiProperty } from "@nestjs/swagger";

export class KeyChainCsrResponseDto {
    @ApiProperty({
        description:
            "PKCS#10 certificate signing request for the active key, PEM encoded and signed by that key.",
        example:
            "-----BEGIN CERTIFICATE REQUEST-----\nMIIB...\n-----END CERTIFICATE REQUEST-----",
    })
    csr!: string;
}
