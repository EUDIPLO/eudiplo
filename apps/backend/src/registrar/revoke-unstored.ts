import type { LoggerService } from "@nestjs/common";
import type { IssuedCertificate } from "./issued-certificate.js";

/**
 * Best-effort revocation of an issued certificate EUDIPLO did not store.
 * Never throws: the caller reports why storing failed.
 *
 * @param reason - Start of the log line, such as "Could not download".
 */
export async function revokeUnstored(
    logger: LoggerService,
    tenantId: string,
    issued: IssuedCertificate<unknown>,
    kind: "access" | "registration",
    reason = "Did not store",
): Promise<void> {
    if (!issued.revoke) {
        return;
    }
    const what = `${issued.registrar} ${kind} certificate ${issued.id}`;
    try {
        await issued.revoke();
        logger.warn(
            `[${tenantId}] ${reason} ${what}; revoked it at the ${issued.registrar}`,
        );
    } catch (error) {
        logger.error(
            `[${tenantId}] ${reason} ${what} and could not revoke it at the ${issued.registrar}; revoke it there by hand: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}
