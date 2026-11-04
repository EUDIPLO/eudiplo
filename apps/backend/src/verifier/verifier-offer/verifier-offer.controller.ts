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
import { Role } from "../../auth/roles/role.enum.js";
import { Secured } from "../../auth/secure.decorator.js";
import { Token, TokenPayload } from "../../auth/token.decorator.js";
import { OfferResponse } from "../../issuer/issuance/oid4vci/dto/offer-request.dto.js";
import { Iso18013OfferResponse } from "../iso18013/dto/iso18013-offer-response.dto.js";
import { Iso18013Service } from "../iso18013/iso18013.service.js";
import {
    PresentationRequest,
    ResponseType,
} from "../oid4vp/dto/presentation-request.dto.js";
import { Oid4vpService } from "../oid4vp/oid4vp.service.js";

@ApiTags("Verifier")
@ApiExtraModels(OfferResponse, Iso18013OfferResponse)
@Secured([Role.PresentationRequest, Role.Presentations])
@Controller("verifier/offer")
export class VerifierOfferController {
    constructor(
        private readonly oid4vpService: Oid4vpService,
        private readonly iso18013Service: Iso18013Service,
    ) {}

    /**
     * Create an presentation request that can be sent to the user
     * @param res
     * @param body
     */
    @ApiResponse({
        description:
            'JSON response; `Iso18013OfferResponse` for `response_type: "iso-18013-7"`',
        status: 201,
        content: {
            "application/json": {
                schema: {
                    oneOf: [
                        { $ref: "#/components/schemas/OfferResponse" },
                        { $ref: "#/components/schemas/Iso18013OfferResponse" },
                    ],
                },
            },
            "image/png": { schema: { type: "string", format: "binary" } },
        },
    })
    @ApiProduces("application/json", "image/png")
    @ApiBody({
        type: PresentationRequest,
        examples: {
            uri: {
                summary: "URI",
                value: {
                    response_type: ResponseType.URI,
                    requestId: "pid",
                },
            },
            "dc-api": {
                summary: "DC API",
                value: {
                    response_type: ResponseType.DC_API,
                    requestId: "pid",
                    expected_origin: "https://shop.example",
                },
            },
        },
    })
    @Post()
    async getOffer(
        @Res() res: Response,
        @Body() body: PresentationRequest,
        @Token() user: TokenPayload,
    ) {
        // Check resource-level authorization
        if (user.client?.allowedPresentationConfigs?.length) {
            if (
                !user.client.allowedPresentationConfigs.includes(body.requestId)
            ) {
                throw new ForbiddenException(
                    `Client is not authorized to use presentation config: ${body.requestId}`,
                );
            }
        }

        // Only the caller's explicit value counts: an Origin header here is
        // that of whoever reached the caller's backend, not the caller's own
        // page. allowedOrigins of the configuration may limit it further.
        const expectedOrigin = body.expected_origin;

        // ISO 18013-7 Annex C: org.iso.mdoc via DC API
        if (body.response_type === ResponseType.ISO_18013_7) {
            const offer = await this.iso18013Service.createOffer(
                body.requestId,
                user.entity!.id,
                expectedOrigin,
                body.skewSeconds,
                body.webhook,
                body.reference,
            );
            return res.status(201).json(offer);
        }

        const values = await this.oid4vpService.createRequest(
            body.requestId,
            {
                webhook: body.webhook,
                redirectUri: body.redirectUri,
                transaction_data: body.transaction_data,
                skewSeconds: body.skewSeconds,
                clientIdScheme: body.clientIdScheme,
                reference: body.reference,
            },
            user.entity!.id,
            body.response_type === ResponseType.DC_API,
            expectedOrigin,
        );
        values.uri = `openid4vp://?${values.uri}`;
        values.crossDeviceUri = `openid4vp://?${values.crossDeviceUri}`;
        res.status(201).json(values);
    }
}
