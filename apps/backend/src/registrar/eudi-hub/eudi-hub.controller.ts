import { Body, Controller, HttpCode, HttpStatus, Post } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { Role } from "../../auth/roles/role.enum.js";
import { Secured } from "../../auth/secure.decorator.js";
import { Token, TokenPayload } from "../../auth/token.decorator.js";
import {
    EudiHubAccessCertificateRequestDto,
    EudiHubIssuerRegistrationCertificateRequestDto,
    EudiHubOrganizationDetailsRequestDto,
    EudiHubOrganizationsRequestDto,
    EudiHubPresentationRegistrationCertificateRequestDto,
} from "./dto/eudi-hub-request.dto.js";
import {
    EudiHubAccessCertificateDto,
    EudiHubOrganizationDetailsDto,
    EudiHubOrganizationDto,
    EudiHubRegistrationCertificateDto,
} from "./dto/eudi-hub-response.dto.js";
import { EudiHubService } from "./eudi-hub.service.js";
import { EUDI_HUB_NO_CERTIFICATE_REQUESTED } from "./eudi-hub-errors.js";
import { EudiHubRegistrationService } from "./eudi-hub-registration.service.js";

const HUB_UNAVAILABLE =
    "The EUDI Hub could not be reached, answered with a server error, or answered with something other than its API describes";

const TOKEN_REFUSED =
    "The request is invalid, or the EUDI Hub refused the access token (expired, not from the portal) or the request; the message carries the EUDI Hub's reason";

/**
 * Requests to the German EUDI Hub with an access token copied from its
 * portal. The token comes in the request body and is not stored.
 */
@ApiTags("EUDI Hub")
@Secured([Role.Registrar])
@Controller("eudi-hub")
export class EudiHubController {
    constructor(
        private readonly eudiHubService: EudiHubService,
        private readonly registration: EudiHubRegistrationService,
    ) {}

    @Post("organizations")
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: "List the EUDI Hub organizations of an access token",
        description:
            "Returns the organizations the user of the pasted EUDI Hub portal token is assigned to. The token is used for this request only.",
    })
    @ApiResponse({
        status: 200,
        description: "Organizations of the token's user",
        type: [EudiHubOrganizationDto],
    })
    @ApiResponse({ status: 400, description: TOKEN_REFUSED })
    @ApiResponse({
        status: 403,
        description: "The caller lacks the registrar:manage role",
    })
    @ApiResponse({
        status: 502,
        description: HUB_UNAVAILABLE,
    })
    listOrganizations(
        @Token() token: TokenPayload,
        @Body() dto: EudiHubOrganizationsRequestDto,
    ): Promise<EudiHubOrganizationDto[]> {
        return this.eudiHubService.listOrganizations(
            token.entity!.id,
            dto.token,
        );
    }

    @Post("access-certificate")
    @ApiOperation({
        summary: "Request an access certificate from the EUDI Hub for a key",
        description:
            "Sends a CSR of the standalone access key chain to the EUDI Hub with the pasted portal token, downloads the issued certificate and stores it as the key chain's active certificate. " +
            "The token is used for this request only. " +
            "When the request gets no answer, a valid certificate of the same name for the key is stored instead; a certificate EUDIPLO cannot download or store is revoked at the EUDI Hub.",
    })
    @ApiResponse({
        status: 201,
        description: "Access certificate issued and stored",
        type: EudiHubAccessCertificateDto,
    })
    @ApiResponse({
        status: 400,
        description: `${TOKEN_REFUSED}. Also returned when the key chain is not a standalone access key chain, the issued certificate does not hold its key, or the outbound URL policy blocks the EUDI Hub URL`,
    })
    @ApiResponse({
        status: 403,
        description: "The caller lacks the registrar:manage role",
    })
    @ApiResponse({ status: 404, description: "Key chain not found" })
    @ApiResponse({
        status: 502,
        description: HUB_UNAVAILABLE,
    })
    requestAccessCertificate(
        @Token() token: TokenPayload,
        @Body() dto: EudiHubAccessCertificateRequestDto,
    ): Promise<EudiHubAccessCertificateDto> {
        return this.eudiHubService.requestAccessCertificate(
            token.entity!.id,
            dto,
        );
    }

    @Post("organization-details")
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: "Read what the EUDI Hub knows about an organization",
        description:
            "Returns the identifiers, service descriptions, privacy policy and contact URLs of an organization at the EUDI Hub, which a registration certificate needs. The pasted portal token is used for this request only.",
    })
    @ApiResponse({
        status: 200,
        description: "The organization's data",
        type: EudiHubOrganizationDetailsDto,
    })
    @ApiResponse({ status: 400, description: TOKEN_REFUSED })
    @ApiResponse({
        status: 403,
        description: "The caller lacks the registrar:manage role",
    })
    @ApiResponse({ status: 502, description: HUB_UNAVAILABLE })
    organizationDetails(
        @Token() token: TokenPayload,
        @Body() dto: EudiHubOrganizationDetailsRequestDto,
    ): Promise<EudiHubOrganizationDetailsDto> {
        return this.registration.organizationDetails(token.entity!.id, dto);
    }

    @Post("registration-certificate/presentation")
    @Secured([Role.Registrar, Role.Presentations], { match: "all" })
    @ApiOperation({
        summary:
            "Request a verifier registration certificate from the EUDI Hub",
        description:
            "Registers the DCQL query of a presentation configuration (with <TENANT_URL> resolved) at the EUDI Hub as a credential request (or uses an existing one with the same credentials, purpose and privacy policy), requests a registration certificate for it and stores it as the configuration's registration_cert: the JWT with the purpose and privacy policy. A purpose or privacy policy the request leaves out is taken from registration_cert, so renewing needs neither again. Storing runs the checks of every registration certificate, such as the overasking check. " +
            "The pasted portal token is used for this request only, so the certificate is not renewed automatically. A certificate EUDIPLO cannot download or store is revoked at the EUDI Hub.",
    })
    @ApiResponse({
        status: 201,
        description: "Registration certificate issued and stored",
        type: EudiHubRegistrationCertificateDto,
    })
    @ApiResponse({
        status: 400,
        description: `${TOKEN_REFUSED}. Also returned when neither the request nor registration_cert has a purpose or privacy policy, the purpose lacks a German or English text, the DCQL query cannot be registered at the EUDI Hub (no credential queries, a format other than dc+sd-jwt or mso_mdoc, several vct values, meta other than vct_values or doctype_value, no claims, array indexes or wildcards in claim paths) or the certificate fails the checks of a registration certificate, such as the overasking check`,
    })
    @ApiResponse({
        status: 403,
        description:
            "The caller lacks the registrar:manage or presentation:manage role",
    })
    @ApiResponse({
        status: 409,
        description: "Presentation configuration not found",
    })
    @ApiResponse({
        status: 502,
        description: `${HUB_UNAVAILABLE}. When this happens while finding or registering the credential request, before a certificate is requested, the body has the code ${EUDI_HUB_NO_CERTIFICATE_REQUESTED}`,
    })
    requestPresentationRegistrationCertificate(
        @Token() token: TokenPayload,
        @Body() dto: EudiHubPresentationRegistrationCertificateRequestDto,
    ): Promise<EudiHubRegistrationCertificateDto> {
        return this.registration.requestPresentationCertificate(
            token.entity!.id,
            dto,
            token,
        );
    }

    @Post("registration-certificate/issuer")
    @Secured([Role.Registrar, Role.Issuances], { match: "all" })
    @ApiOperation({
        summary: "Request an issuer registration certificate from the EUDI Hub",
        description:
            "Registers each credential type of the tenant's credential configurations (vct or docType) at the EUDI Hub as a credential issuance, if it is not registered yet, requests a registration certificate for them and stores the JWT and the support URI in the issuance configuration's registrationCertificate, which it enables. " +
            "The pasted portal token is used for this request only, so the certificate is not renewed automatically. A certificate that does not list every type, or that EUDIPLO cannot download or store, is revoked at the EUDI Hub.",
    })
    @ApiResponse({
        status: 201,
        description: "Registration certificate issued and stored",
        type: EudiHubRegistrationCertificateDto,
    })
    @ApiResponse({
        status: 400,
        description: `${TOKEN_REFUSED}. Also returned when no credential configuration has a vct or docType`,
    })
    @ApiResponse({
        status: 403,
        description:
            "The caller lacks the registrar:manage or issuance:manage role",
    })
    @ApiResponse({
        status: 502,
        description: `${HUB_UNAVAILABLE}, or it issued a certificate that does not list every credential type, which is then revoked. When the EUDI Hub fails while reading or registering the credential issuances, before a certificate is requested, the body has the code ${EUDI_HUB_NO_CERTIFICATE_REQUESTED}`,
    })
    requestIssuerRegistrationCertificate(
        @Token() token: TokenPayload,
        @Body() dto: EudiHubIssuerRegistrationCertificateRequestDto,
    ): Promise<EudiHubRegistrationCertificateDto> {
        return this.registration.requestIssuerCertificate(
            token.entity!.id,
            dto,
            token,
        );
    }
}
