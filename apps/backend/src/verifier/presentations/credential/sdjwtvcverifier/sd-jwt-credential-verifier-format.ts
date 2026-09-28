import { Injectable } from "@nestjs/common";
import type { VerificationResult } from "@sd-jwt/sd-jwt-vc";
import type { VerifierOptions } from "../../../../trust/types.js";
import type { SdJwtCredentialVerifier } from "../credential-verifier-format.js";
import { SdjwtvcverifierService } from "./sdjwtvcverifier.service.js";

@Injectable()
export class SdJwtCredentialVerifierFormat implements SdJwtCredentialVerifier {
    readonly format = "dc+sd-jwt" as const;

    constructor(private readonly verifier: SdjwtvcverifierService) {}

    verify(
        credential: string,
        options: VerifierOptions,
    ): Promise<VerificationResult> {
        return this.verifier.verify(credential, options);
    }
}
