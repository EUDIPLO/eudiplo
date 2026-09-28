import { Controller, Get, NotFoundException, Param } from "@nestjs/common";
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
import {
    CredentialOfferNotFound,
    RetrieveCredentialOffer,
} from "./application/retrieve-credential-offer.js";

@ApiTags("OID4VCI")
@ApiParam({ name: "tenantId", required: true })
@Controller("issuers/:tenantId/vci")
export class CredentialOfferReferenceController {
    constructor(
        private readonly retrieveCredentialOffer: RetrieveCredentialOffer,
    ) {}

    @Get("credential-offers/:sessionId")
    @ApiOperation({ summary: "Resolve a credential offer by reference" })
    @ApiParam({ name: "sessionId", required: true })
    @ApiResponse({ status: 200, description: "Credential offer" })
    @ApiResponse({ status: 404, description: "Credential offer not found" })
    async credentialOfferByReference(
        @Param("tenantId") tenantId: string,
        @Param("sessionId") sessionId: string,
    ) {
        try {
            return await this.retrieveCredentialOffer.execute(
                tenantId,
                sessionId,
            );
        } catch (error) {
            if (error instanceof CredentialOfferNotFound) {
                throw new NotFoundException(error.message);
            }
            throw error;
        }
    }
}
