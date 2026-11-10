import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { ApiService } from '../core';
import { firstValueFrom } from 'rxjs';
import type {
  CreateAccessKeyChainDto,
  RegistrarControllerCreateAccessCertificateResponse,
  RegistrarControllerCreateAccessKeyChainResponse,
} from '@eudiplo/sdk-core';

/**
 * Contact sent when EUDIPLO registers the relying party at the registrar.
 */
export interface RelyingPartyContact {
  supportUri?: string;
  email?: string;
  phone?: string;
}

/**
 * Registrar configuration response from the API.
 * The password and client secret are never returned for security reasons; instead
 * hasPassword and hasClientSecret indicate if one is set.
 */
export interface RegistrarConfig {
  tenantId?: string;
  registrarUrl: string;
  oidcUrl: string;
  clientId: string;
  username: string;
  registrationCertificateDefaults?: Record<string, unknown> | null;
  relyingPartyContact?: RelyingPartyContact | null;
  /** Indicates whether a password is configured (actual password is never returned) */
  hasPassword: boolean;
  /** Indicates whether a client secret is configured (actual secret is never returned) */
  hasClientSecret: boolean;
}

/**
 * Registrar configuration for create/update requests.
 */
export interface RegistrarConfigRequest {
  registrarUrl: string;
  oidcUrl: string;
  clientId: string;
  clientSecret?: string;
  username: string;
  registrationCertificateDefaults?: Record<string, unknown> | null;
  relyingPartyContact?: RelyingPartyContact | null;
  password?: string;
}

/**
 * Response from creating an access key enrolled at the registrar.
 */
export type AccessCertificateResponse = RegistrarControllerCreateAccessKeyChainResponse;

/** Fragment of the Relying Party Contact section, linked from contact hints. */
export const RELYING_PARTY_CONTACT_ANCHOR = 'relying-party-contact';

/** The values of a relying party contact; one of them is enough. */
export const RELYING_PARTY_CONTACT_FIELDS = ['supportUri', 'email', 'phone'] as const;

/**
 * Whether the configuration has a relying party contact. The registrar needs
 * one to register the relying party on its first enrollment; a relying party
 * that is already registered keeps its contact, so a missing one is a hint only.
 */
export function hasRelyingPartyContact(config: RegistrarConfig): boolean {
  return RELYING_PARTY_CONTACT_FIELDS.some((field) => config.relyingPartyContact?.[field]?.trim());
}

/**
 * Response from enrolling an existing key at the registrar.
 */
export type AccessCertificateEnrollmentResponse =
  RegistrarControllerCreateAccessCertificateResponse;

/**
 * Why EUDIPLO refused {@link RegistrarService.createAccessCertificate}. It
 * refuses before it stores the certificate, its last step, so the key keeps
 * the certificate it had: `role` (403) without registrar:manage; `registrar`
 * (400) when the registrar authentication, the relying party registration or
 * the certificate request fails and the registrar lists no other certificate
 * for the key, or (404) without registrar configuration or key. The backend's
 * access-certificate.service.spec.ts pins that order.
 */
export type AccessCertificateRefusal = 'role' | 'registrar';

/**
 * Why a failed {@link RegistrarService.createAccessCertificate} was refused;
 * undefined when it failed otherwise and the certificate may have been stored.
 */
export function accessCertificateRefusal(error: unknown): AccessCertificateRefusal | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  if (status === 403) return 'role';
  if (status === 400 || status === 404) return 'registrar';
  return undefined;
}

/**
 * How {@link RegistrarService.createAccessKeyChain} failed, which decides
 * what the user can do next:
 * - `role` (403): the caller lacks registrar:manage; no key was created.
 * - `registrar` (400 or 404 caused by the registrar): its authentication, the
 *   relying party registration or the certificate request failed, or there
 *   is no registrar configuration; EUDIPLO kept no key.
 * - `refused` (another 400 or 404, for example an unknown KMS provider): no
 *   key was kept, and the registrar configuration is not the cause.
 * - `keyLeft` (5xx naming a key chain): EUDIPLO could not delete the new key
 *   chain `keyId`, which has no registrar certificate.
 * - `failed` (another 5xx from EUDIPLO): EUDIPLO kept no key.
 * - `unknown` (no answer, or 502, 503 or 504 from a proxy): the request may
 *   still have created and enrolled a key.
 *
 * The backend's access-certificate.service.spec.ts pins the messages read here.
 */
export type AccessKeyEnrollmentFailure =
  | { kind: 'role' | 'registrar' | 'refused' | 'failed' | 'unknown' }
  | { kind: 'keyLeft'; keyId: string };

const GATEWAY_STATUSES = new Set([0, 502, 503, 504]);
const KEY_LEFT_MESSAGE = /The new access key chain (\S+) could not be deleted/;
const REGISTRAR_CAUSE = /registrar|access certificate/i;

export function accessKeyEnrollmentFailure(error: unknown): AccessKeyEnrollmentFailure {
  const { status, error: body } = (error ?? {}) as { status?: number; error?: unknown };
  const message =
    typeof (body as { message?: unknown } | null)?.message === 'string'
      ? (body as { message: string }).message
      : '';
  if (status === undefined || GATEWAY_STATUSES.has(status)) return { kind: 'unknown' };
  if (status === 403) return { kind: 'role' };
  if (status === 400 || status === 404) {
    return { kind: REGISTRAR_CAUSE.test(message) ? 'registrar' : 'refused' };
  }
  const keyLeft = KEY_LEFT_MESSAGE.exec(message);
  if (keyLeft) return { kind: 'keyLeft', keyId: keyLeft[1] };
  return { kind: status >= 500 ? 'failed' : 'refused' };
}

/**
 * Service for managing registrar configuration and creating access certificates.
 */
@Injectable({
  providedIn: 'root',
})
export class RegistrarService {
  constructor(
    private readonly http: HttpClient,
    private readonly apiService: ApiService
  ) {}

  private getBaseUrl(): string {
    return this.apiService.getBaseUrl() || '';
  }

  /**
   * Get the current registrar configuration.
   */
  async getConfig(): Promise<RegistrarConfig | null> {
    try {
      const response = await firstValueFrom(
        this.http.get<RegistrarConfig>(`${this.getBaseUrl()}/api/registrar/config`)
      );
      return response;
    } catch (error: any) {
      if (error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Create or replace the registrar configuration.
   * Credentials are validated before saving.
   */
  async saveConfig(config: RegistrarConfigRequest): Promise<RegistrarConfig> {
    return firstValueFrom(
      this.http.post<RegistrarConfig>(`${this.getBaseUrl()}/api/registrar/config`, config)
    );
  }

  /**
   * Update the registrar configuration.
   * Credentials are validated if auth-related fields are changed.
   */
  async updateConfig(config: Partial<RegistrarConfigRequest>): Promise<RegistrarConfig> {
    return firstValueFrom(
      this.http.patch<RegistrarConfig>(`${this.getBaseUrl()}/api/registrar/config`, config)
    );
  }

  /**
   * Delete the registrar configuration.
   */
  async deleteConfig(): Promise<void> {
    await firstValueFrom(this.http.delete<void>(`${this.getBaseUrl()}/api/registrar/config`));
  }

  /**
   * Create a standalone access key and enroll it at the registrar in one
   * request. When the enrollment fails, the backend deletes the key again.
   */
  /**
   * Create an access certificate for an existing key.
   * The certificate is fetched from the registrar and stored in EUDIPLO.
   */
  createAccessCertificate(keyId: string): Promise<AccessCertificateEnrollmentResponse> {
    return firstValueFrom(
      this.http.post<AccessCertificateEnrollmentResponse>(
        `${this.getBaseUrl()}/api/registrar/access-certificate`,
        { keyId }
      )
    );
  }

  createAccessKeyChain(body: CreateAccessKeyChainDto): Promise<AccessCertificateResponse> {
    return firstValueFrom(
      this.http.post<AccessCertificateResponse>(
        `${this.getBaseUrl()}/api/registrar/access-key-chain`,
        body
      )
    );
  }
}
