import { Injectable } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import { SdjwtvcverifierService } from "../credential/sdjwtvcverifier/sdjwtvcverifier.service.js";
import type {
    CredentialVerificationContext,
    CredentialVerificationResult,
    CredentialVerifierFormat,
    Oid4vpPresentationBinding,
} from "../domain/credential-verifier-format.js";
import {
    matchesClaimSelection,
    sdJwtRequiredClaimKeys,
} from "../domain/dcql-claim-policy.js";

/**
 * SD-JWT VC verifier format. The verifier enforces the requested claims and
 * throws `SdJwtVerificationError` (or a library error) on failure. With
 * `claim_sets` the credential is verified once and the options are matched
 * against the disclosed claims.
 */
@Injectable()
export class SdJwtCredentialVerifierFormat implements CredentialVerifierFormat {
    readonly format = "dc+sd-jwt";

    constructor(
        private readonly verifier: SdjwtvcverifierService,
        private readonly logger: PinoLogger,
    ) {
        this.logger.setContext(SdJwtCredentialVerifierFormat.name);
    }

    async verify(
        credential: string,
        context: CredentialVerificationContext,
    ): Promise<CredentialVerificationResult> {
        const binding = context.binding;
        if (binding.protocol !== "openid4vp") {
            throw new Error(
                `SD-JWT VC cannot be verified for protocol '${binding.protocol}'`,
            );
        }

        const checkedClaimKeys = context.claimSets
            ? []
            : sdJwtRequiredClaimKeys(context.claims);
        const result = await this.verifier.verify(credential, {
            requiredClaimKeys: checkedClaimKeys,
            keyBindingNonce: binding.sessionNonce!,
            keyBindingAudience: this.keyBindingAudience(binding),
            ...context.options,
            keyBindingResponseMode: binding.request?.response_mode,
        });
        const payload = (result.payload ?? {}) as Record<string, unknown>;

        const claimSetSatisfied = context.claimSets
            ? context.claimSets.some((selectedClaims) =>
                  matchesClaimSelection(
                      payload,
                      context.claims,
                      selectedClaims,
                  ),
              )
            : undefined;

        if (claimSetSatisfied !== false) {
            this.logger.debug(
                {
                    credentialId: context.credentialId,
                    requiredClaimKeys: checkedClaimKeys,
                    disclosedClaimKeys: Object.keys(result.payload ?? {}),
                },
                "SD-JWT-VC disclosed claims after verification",
            );
            this.logger.trace(
                {
                    credentialId: context.credentialId,
                    requiredClaimKeys: checkedClaimKeys,
                    disclosedClaims: result.payload,
                },
                "[TRACE] SD-JWT-VC full disclosed claims payload",
            );
        }

        return {
            verified: true,
            // Holder key and status reference are not claims about the subject.
            claims: { ...result.payload, cnf: undefined, status: undefined },
            missingClaims: [],
            claimSetSatisfied,
        };
    }

    /**
     * The KB-JWT audience is the verifier's client_id; over the DC API it is
     * the expected origin (`origin:<origin>`), falling back to the client_id.
     */
    private keyBindingAudience(
        binding: Oid4vpPresentationBinding,
    ): string | undefined {
        const defaultAudience =
            binding.request?.client_id ?? binding.sessionClientId;

        if (!binding.useDcApi) {
            return defaultAudience;
        }

        const expectedOrigin = binding.request?.expected_origins?.[0];
        const normalizedOrigin = normalizeDcApiOrigin(expectedOrigin);
        if (normalizedOrigin) {
            return `origin:${normalizedOrigin}`;
        }

        this.logger.warn(
            {
                sessionId: binding.sessionId,
                expectedOrigin,
                defaultAudience,
            },
            "Missing or invalid expected_origin for DC API; falling back to client_id for SD-JWT key binding audience",
        );
        return defaultAudience;
    }
}

function normalizeDcApiOrigin(origin: string | undefined): string | undefined {
    if (!origin) {
        return undefined;
    }

    const trimmed = origin.trim();
    if (!trimmed) {
        return undefined;
    }

    const withoutPrefix = trimmed.startsWith("origin:")
        ? trimmed.slice("origin:".length)
        : trimmed;
    const withProtocol = /^https?:\/\//i.test(withoutPrefix)
        ? withoutPrefix
        : `http://${withoutPrefix}`;

    try {
        const parsed = new URL(withProtocol);
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
            return undefined;
        }

        return parsed.origin;
    } catch {
        return undefined;
    }
}
