import { Injectable } from '@angular/core';
import {
  type EudiHubAccessCertificateDto,
  type EudiHubAccessCertificateRequestDto,
  type EudiHubIssuerRegistrationCertificateRequestDto,
  type EudiHubOrganizationDetailsDto,
  type EudiHubOrganizationDto,
  type EudiHubPresentationRegistrationCertificateRequestDto,
  type EudiHubRegistrationCertificateDto,
  eudiHubControllerListOrganizations,
  eudiHubControllerOrganizationDetails,
  eudiHubControllerRequestAccessCertificate,
  eudiHubControllerRequestIssuerRegistrationCertificate,
  eudiHubControllerRequestPresentationRegistrationCertificate,
} from '@eudiplo/sdk-core';

/** An organization at the EUDI Hub. */
export type EudiHubOrganization = EudiHubOrganizationDto;

/** A certificate the EUDI Hub issued and EUDIPLO stored in the key chain. */
export type EudiHubAccessCertificate = EudiHubAccessCertificateDto;

/** What the EUDI Hub knows about an organization that a registration certificate needs. */
export type EudiHubOrganizationDetails = EudiHubOrganizationDetailsDto;

/** A registration certificate the EUDI Hub issued and EUDIPLO stored. */
export type EudiHubRegistrationCertificate = EudiHubRegistrationCertificateDto;

/**
 * `code` of a backend error for an EUDI Hub failure before a certificate was
 * requested, so the request cannot have stored one. Same value as in the
 * backend's `eudi-hub-errors.ts`; without it the dialog says a certificate
 * may have been stored.
 */
export const EUDI_HUB_NO_CERTIFICATE_REQUESTED = 'EUDI_HUB_NO_CERTIFICATE_REQUESTED';

/** Where users sign in to the EUDI Hub and copy their access token from. */
export const EUDI_HUB_PORTAL_URL = 'https://portal.eudi-hub.gov.de/';

/**
 * Requests to the German EUDI Hub through EUDIPLO, with an access token the
 * user copied from the portal. The token is sent with each request and kept
 * nowhere else.
 */
@Injectable({ providedIn: 'root' })
export class EudiHubService {
  /** The organizations the user of the token is assigned to. */
  async listOrganizations(token: string): Promise<EudiHubOrganization[]> {
    const response = await eudiHubControllerListOrganizations({ body: { token } });
    return response.data;
  }

  /** Request an access certificate for a key chain and store it there. */
  async requestAccessCertificate(
    body: EudiHubAccessCertificateRequestDto
  ): Promise<EudiHubAccessCertificate> {
    const response = await eudiHubControllerRequestAccessCertificate({ body });
    return response.data;
  }

  /** Identifiers, service descriptions and contact data of an organization. */
  async organizationDetails(
    token: string,
    organizationId: string
  ): Promise<EudiHubOrganizationDetails> {
    const response = await eudiHubControllerOrganizationDetails({
      body: { token, organizationId },
    });
    return response.data;
  }

  /** Request a verifier registration certificate and store it in the presentation configuration. */
  async requestPresentationRegistrationCertificate(
    body: EudiHubPresentationRegistrationCertificateRequestDto
  ): Promise<EudiHubRegistrationCertificate> {
    const response = await eudiHubControllerRequestPresentationRegistrationCertificate({ body });
    return response.data;
  }

  /** Request an issuer registration certificate and store it in the issuance configuration. */
  async requestIssuerRegistrationCertificate(
    body: EudiHubIssuerRegistrationCertificateRequestDto
  ): Promise<EudiHubRegistrationCertificate> {
    const response = await eudiHubControllerRequestIssuerRegistrationCertificate({ body });
    return response.data;
  }
}
