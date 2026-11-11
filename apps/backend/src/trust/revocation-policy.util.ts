import { RevocationCheckMode, VerifierOptions, VerifyPolicy } from "./types.js";

const DEFAULT_REVOCATION_POLICY: NonNullable<VerifyPolicy["revocation"]> = {
    enabled: true,
    failClosed: true,
};

export function revocationModeToPolicy(
    mode?: RevocationCheckMode,
): NonNullable<VerifyPolicy["revocation"]> {
    switch (mode) {
        case RevocationCheckMode.Disabled:
            return {
                enabled: false,
                failClosed: false,
            };
        case RevocationCheckMode.BestEffort:
            return {
                enabled: true,
                failClosed: false,
            };
        case RevocationCheckMode.Strict:
        default:
            return { ...DEFAULT_REVOCATION_POLICY };
    }
}

export function resolveRevocationPolicy(
    options: VerifierOptions,
): Required<
    Pick<NonNullable<VerifyPolicy["revocation"]>, "enabled" | "failClosed">
> {
    const configured = options.policy.revocation;

    return {
        enabled: configured?.enabled ?? DEFAULT_REVOCATION_POLICY.enabled,
        failClosed:
            configured?.failClosed ??
            DEFAULT_REVOCATION_POLICY.failClosed ??
            true,
    };
}

/**
 * A status list or identifier list could not be fetched: the request failed,
 * timed out, returned a non-2xx status or was blocked by the outbound URL
 * policy. The best-effort revocation mode then verifies without the status
 * check. It is recognised by its class, never by its message: a list's URI
 * in a message can read like an availability problem.
 */
export class RevocationListUnavailableError extends Error {}
