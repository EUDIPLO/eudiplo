import type { VerificationResult } from "@sd-jwt/sd-jwt-vc";
import type { VerifierOptions } from "../../../trust/types.js";
import type {
    MdocSessionData,
    MdocVerificationResult,
    RequestedMdocClaimPath,
} from "./mdocverifier/mdocverifier.service.js";

export interface MdocCredentialVerifier {
    readonly format: "mso_mdoc";
    verify(
        credential: string,
        sessionData: MdocSessionData,
        options: VerifierOptions,
        requestedClaimPaths?: RequestedMdocClaimPath[],
    ): Promise<MdocVerificationResult>;
}

export interface SdJwtCredentialVerifier {
    readonly format: "dc+sd-jwt";
    verify(
        credential: string,
        options: VerifierOptions,
    ): Promise<VerificationResult>;
}

export type CredentialVerifierFormat =
    | MdocCredentialVerifier
    | SdJwtCredentialVerifier;
