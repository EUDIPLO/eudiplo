import { Controller, Get, Inject } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Role } from "../auth/roles/role.enum.js";
import { Secured } from "../auth/secure.decorator.js";
import { requireTenantContext } from "../auth/tenant-context.util.js";
import { Token, type TokenPayload } from "../auth/token.decorator.js";
import { TrustListStatusResponseDto } from "./dto/trust-list-status-response.dto.js";
import {
    TRUST_LIST_FETCH_STATUSES,
    type TrustListFetchStatuses,
} from "./ports/trust-list-fetch-statuses.js";

/**
 * How the trust lists a tenant uses were last loaded, so operators see a
 * list that fails or lapses before verification refuses credentials for it.
 */
@ApiTags("Trust List Status")
@Controller("trust-list-status")
@Secured([Role.Issuances, Role.Presentations])
export class TrustListStatusController {
    constructor(
        @Inject(TRUST_LIST_FETCH_STATUSES)
        private readonly statuses: TrustListFetchStatuses,
    ) {}

    @Get()
    @ApiOperation({
        summary: "Get the status of the trust lists in use",
        description:
            "Returns, per trust list URL, how the caller's tenant last loaded it: when, whether it was accepted and why not, and the NextUpdate, LoTESequenceNumber and entity count of the last verified version. Lists referenced by URL are loaded when a presentation request is created for a query that references them; every list is loaded when a credential, wallet attestation or key attestation is checked against it, and wallet-provider lists also by the periodic wallet unit status check, at most as often as the trust list cache allows. A list that could not be fetched or verified is loaded again on its next use; other lists not accepted are loaded again as the cache allows. A list appears after its first use, and entries stay until the tenant is deleted. Most recently checked first.",
    })
    @ApiOkResponse({ type: [TrustListStatusResponseDto] })
    getStatus(
        @Token() token: TokenPayload,
    ): Promise<TrustListStatusResponseDto[]> {
        return this.statuses.list(requireTenantContext(token));
    }
}
