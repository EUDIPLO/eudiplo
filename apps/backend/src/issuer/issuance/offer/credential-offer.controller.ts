import {
    Body,
    Controller,
    ForbiddenException,
    Post,
    Res,
} from "@nestjs/common";
import {
    ApiBody,
    ApiExtraModels,
    ApiProduces,
    ApiResponse,
    ApiTags,
} from "@nestjs/swagger";
import { Response } from "express";
import { Role } from "../../../auth/roles/role.enum.js";
import { Secured } from "../../../auth/secure.decorator.js";
import { Token, TokenPayload } from "../../../auth/token.decorator.js";
import { ResponseType } from "../../../verifier/oid4vp/dto/presentation-request.dto.js";
import {
    FlowType,
    OfferRequestDto,
    OfferResponse,
} from "../oid4vci/dto/offer-request.dto.js";
import { Oid4vciService } from "../oid4vci/oid4vci.service.js";

@ApiTags("Issuer")
@ApiExtraModels(OfferResponse)
@Secured([Role.IssuanceOffer])
@Controller("issuer/offer")
export class CredentialOfferController {
    constructor(private readonly oid4vciService: Oid4vciService) {}

    /**
     * Create an offer for a credential.
     * @param res
     * @param body
     */
    @ApiResponse({
        description: "JSON response",
        status: 201,
        content: {
            "application/json": {
                schema: { $ref: "#/components/schemas/OfferResponse" },
            },
            "image/png": { schema: { type: "string", format: "binary" } },
        },
    })
    @ApiProduces("application/json", "image/png")
    @ApiBody({
        type: OfferRequestDto,
        examples: {
            uri: {
                summary: "URI",
                value: {
                    response_type: ResponseType.URI,
                    credentialConfigurationIds: ["pid"],
                    flow: FlowType.PRE_AUTH_CODE,
                } as OfferRequestDto,
            },
        },
    })
    @Post()
    async getOffer(
        @Res() res: Response,
        @Body() body: OfferRequestDto,
        @Token() user: TokenPayload,
    ) {
        // Check if client has restricted issuance configs
        if (user.client?.allowedIssuanceConfigs?.length) {
            const unauthorized = body.credentialConfigurationIds.filter(
                (configId) =>
                    !user.client!.allowedIssuanceConfigs!.includes(configId),
            );
            if (unauthorized.length > 0) {
                throw new ForbiddenException(
                    `Client is not authorized to use issuance config(s): ${unauthorized.join(", ")}`,
                );
            }
        }

        const values = await this.oid4vciService.createOffer(
            user.entity!.id,
            body,
        );

        res.send(values);
    }
}
