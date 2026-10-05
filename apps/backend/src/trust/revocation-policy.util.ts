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
 * check.
 */
export class RevocationListUnavailableError extends Error {}

export function isStatusListUnavailableError(error: unknown): boolean {
    const message = String(
        (error as Error | undefined)?.message ?? error ?? "",
    ).toLowerCase();

    const statusListRelated =
        message.includes("status list") ||
        message.includes("statuslist") ||
        message.includes("revocation");

    const availabilityRelated =
        message.includes("timed out") ||
        message.includes("timeout") ||
        message.includes("failed to fetch") ||
        message.includes("unavailable") ||
        message.includes("network") ||
        message.includes("econn") ||
        message.includes("enotfound") ||
        message.includes("eai_again") ||
        message.includes("canceled") ||
        message.includes("cancelled");

    return statusListRelated && availabilityRelated;
}
