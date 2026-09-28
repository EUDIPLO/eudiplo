import { Injectable } from "@nestjs/common";
import type { VerifierOptions } from "../../../../trust/types.js";
import type { MdocCredentialVerifier } from "../credential-verifier-format.js";
import {
    type MdocSessionData,
    type MdocVerificationResult,
    MdocverifierService,
    type RequestedMdocClaimPath,
} from "./mdocverifier.service.js";

@Injectable()
export class MdocCredentialVerifierFormat implements MdocCredentialVerifier {
    readonly format = "mso_mdoc" as const;

    constructor(private readonly verifier: MdocverifierService) {}

    verify(
        credential: string,
        sessionData: MdocSessionData,
        options: VerifierOptions,
        requestedClaimPaths?: RequestedMdocClaimPath[],
    ): Promise<MdocVerificationResult> {
        return this.verifier.verify(
            credential,
            sessionData,
            options,
            requestedClaimPaths,
        );
    }
}
