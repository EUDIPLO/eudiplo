import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import type {
    SessionOutcome,
    SessionOutcomeCredential,
    SessionOutcomeSource,
    VerificationProvenance,
} from "../domain/session-outcome.js";

/** OpenAPI schema of {@link VerificationProvenance}. */
export class VerificationProvenanceDto implements VerificationProvenance {
    @ApiPropertyOptional({
        description:
            "Name of the matched trust list entry, else the issuance certificate subject; under OpenID Federation the issuer's entity ID.",
    })
    matchedIssuer?: string;

    @ApiPropertyOptional({
        description: "Thumbprint of the matched issuance certificate.",
    })
    issuanceThumbprint?: string;

    @ApiPropertyOptional({
        description:
            "How the chain matched a trusted entity: `ca`, `leaf-pinned` or `pathEnd-pinned`, or `federation` for an OpenID Federation issuer.",
    })
    matchMode?: string;

    @ApiPropertyOptional({
        description: "Thumbprint of the entity's revocation certificate.",
    })
    revocationThumbprint?: string;
}

/** A non-fatal condition observed during verification. */
export class SessionOutcomeWarningDto {
    @ApiProperty({ description: "Machine-readable warning code." })
    code!: string;

    @ApiProperty({ description: "Short, safe message." })
    message!: string;
}

/** OpenAPI schema of {@link SessionOutcomeCredential}. */
export class SessionOutcomeCredentialDto implements SessionOutcomeCredential {
    @ApiPropertyOptional({ description: "Requested credential ID (DCQL)." })
    id?: string;

    @ApiPropertyOptional({
        description: "Credential format, e.g. `mso_mdoc` or `dc+sd-jwt`.",
    })
    format?: string;

    @ApiPropertyOptional({ description: "mDOC docType or SD-JWT VC vct." })
    docType?: string;

    @ApiProperty({ description: "Whether the credential was verified." })
    verified!: boolean;

    @ApiPropertyOptional({ description: "Machine-readable failure code." })
    error?: string;

    @ApiPropertyOptional({ description: "Short, safe failure message." })
    message?: string;

    @ApiPropertyOptional({
        type: VerificationProvenanceDto,
        description: "Trust provenance of a verified credential.",
    })
    trust?: VerificationProvenanceDto;

    @ApiPropertyOptional({
        type: [SessionOutcomeWarningDto],
        description:
            "Reserved for non-fatal conditions observed during verification; currently never set.",
    })
    warnings?: SessionOutcomeWarningDto[];
}

/** OpenAPI schema of {@link SessionOutcome}. */
export class SessionOutcomeDto implements SessionOutcome {
    @ApiProperty({ enum: ["success", "failed"] })
    result!: "success" | "failed";

    @ApiPropertyOptional({
        enum: ["wallet", "verifier"],
        description:
            "Who decided the result: the wallet (an error response or an OID4VCI notification) or EUDIPLO while verifying a presentation.",
    })
    source?: SessionOutcomeSource;

    @ApiPropertyOptional({
        description: "Machine-readable failure code, as in `failureCode`.",
    })
    error?: string;

    @ApiPropertyOptional({ description: "Short, safe failure message." })
    message?: string;

    @ApiPropertyOptional({
        description:
            "Free text the wallet sent with its error or notification. Wallet-controlled: show it as plain text only.",
    })
    description?: string;

    @ApiPropertyOptional({
        type: [SessionOutcomeCredentialDto],
        description:
            "Per credential query: on success every presented query, on a classified verification failure the credential that failed.",
    })
    credentials?: SessionOutcomeCredentialDto[];
}
