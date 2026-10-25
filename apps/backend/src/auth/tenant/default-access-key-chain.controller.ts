import { Body, Controller, Get, Put } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { AuditLogRequestMeta } from "../../audit-log/audit-log.service.js";
import { AuditMeta } from "../../audit-log/audit-log-context.util.js";
import { KeyChainService } from "../../crypto/key/key-chain.service.js";
import { Role } from "../roles/role.enum.js";
import { Secured } from "../secure.decorator.js";
import { Token, TokenPayload } from "../token.decorator.js";
import {
    DefaultAccessKeyChainDto,
    UpdateDefaultAccessKeyChainDto,
} from "./dto/default-access-key-chain.dto.js";
import { TenantService } from "./tenant.service.js";

/**
 * The access key chain of the caller's tenant that is used where no
 * configuration names one. The roles are those that manage key chains.
 */
@ApiTags("Key Chain")
@Secured([Role.Issuances, Role.Presentations, Role.Keys])
@Controller("key-chain/access/default")
export class DefaultAccessKeyChainController {
    constructor(
        private readonly tenantService: TenantService,
        private readonly keyChainService: KeyChainService,
    ) {}

    @Get()
    @ApiOperation({
        summary: "Get the default access key chain",
        description:
            "Returns the tenant's defaultAccessKeyChainId and the access key chain that presentation requests of configurations without accessKeyChainId and the signed issuer metadata use.",
    })
    @ApiResponse({ status: 200, type: DefaultAccessKeyChainDto })
    get(@Token() token: TokenPayload): Promise<DefaultAccessKeyChainDto> {
        return this.keyChainService.getDefaultAccessKeyChain(token.entity!.id);
    }

    @Put()
    @ApiOperation({
        summary: "Set the default access key chain",
        description:
            "Names the access key chain used where no configuration names one, or removes the setting with null so EUDIPLO picks one by rule. A presentation configuration's accessKeyChainId still takes precedence. While a key chain is the default, deleting it is refused.",
    })
    @ApiResponse({ status: 200, type: DefaultAccessKeyChainDto })
    @ApiResponse({
        status: 400,
        description:
            "The key chain does not exist in the tenant or has another usage type than access.",
    })
    set(
        @Token() token: TokenPayload,
        @Body() body: UpdateDefaultAccessKeyChainDto,
        @AuditMeta() requestMeta: AuditLogRequestMeta,
    ): Promise<DefaultAccessKeyChainDto> {
        return this.tenantService.setDefaultAccessKeyChain(
            token.entity!.id,
            body.defaultAccessKeyChainId,
            token,
            requestMeta,
        );
    }
}
