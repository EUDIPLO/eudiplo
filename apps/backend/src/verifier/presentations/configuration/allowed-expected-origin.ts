import { BadRequestException } from "@nestjs/common";
import { resolveExpectedOrigin } from "../domain/expected-origin.js";

/**
 * Origin a DC API offer of presentation configuration `requestId` is bound
 * to: the requested one, if `allowedOrigins` is unset or lists it, or the
 * only allowed one when none is requested.
 * @throws BadRequestException when the configuration does not allow it
 */
export function allowedExpectedOrigin(
    requestId: string,
    requested: string | undefined,
    allowed: readonly string[] | null | undefined,
): string {
    const result = resolveExpectedOrigin(requested, allowed);
    if (result.problem !== undefined) {
        throw new BadRequestException(
            `Presentation config "${requestId}" ${result.problem}`,
        );
    }
    return result.origin;
}
