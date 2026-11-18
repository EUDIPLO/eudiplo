import {
    BadGatewayException,
    BadRequestException,
    HttpException,
    type LoggerService,
} from "@nestjs/common";
import { EudiHubRequestError } from "./eudi-hub.client.js";

/** Name of the registrar in messages and logs. */
export const EUDI_HUB = "EUDI Hub";

/**
 * Whether an error is a failure of the EUDI Hub rather than a refusal: no
 * answer, a server error, an answer that does not match the EUDI Hub API, or
 * an error that is not an EUDI Hub request error. `eudiHubHttpException`
 * answers exactly these with a 502.
 */
export function isEudiHubFailure(error: unknown): boolean {
    if (!(error instanceof EudiHubRequestError)) {
        return true;
    }
    return error.status === undefined ? !error.blocked : error.status >= 500;
}

/**
 * The answer for a failed EUDI Hub request, logged. A refused token is a 400,
 * not a 401, since EUDIPLO's own session is fine. Other refusals and a
 * request the outbound URL policy blocked are a 400 with the reason; no
 * answer, a server error or an answer that does not match the EUDI Hub API
 * is a 502. An error that is not an EUDI Hub request error is a 502 that
 * points to the log.
 */
export function eudiHubHttpException(
    logger: LoggerService,
    tenantId: string,
    error: unknown,
    context: string,
): HttpException {
    if (!(error instanceof EudiHubRequestError)) {
        logger.error(
            `[${tenantId}] ${context}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return new BadGatewayException(
            `${context}; the server log has the cause.`,
        );
    }
    logger.warn(`[${tenantId}] ${context}: ${error.message}`);
    const detail = error.detail ? ` (${error.detail})` : "";
    switch (error.status) {
        case 401:
            return new BadRequestException(
                `${context}: the EUDI Hub did not accept the access token (HTTP 401). It is expired or not a token of the EUDI Hub portal; copy a fresh one.`,
            );
        case 403:
            return new BadRequestException(
                `${context}: the EUDI Hub refused the request (HTTP 403)${detail}. The portal user may lack the permission for this organization.`,
            );
        case undefined:
            if (!isEudiHubFailure(error)) {
                return new BadRequestException(`${context}: ${error.message}`);
            }
            return new BadGatewayException(
                error.invalidAnswer
                    ? `${context}: ${error.message}.`
                    : `${context}: the EUDI Hub could not be reached.`,
            );
        default:
            return isEudiHubFailure(error)
                ? new BadGatewayException(
                      `${context}: the EUDI Hub answered with HTTP ${error.status}${detail}.`,
                  )
                : new BadRequestException(
                      `${context}: the EUDI Hub answered with HTTP ${error.status}${detail}.`,
                  );
    }
}
