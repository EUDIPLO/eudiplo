import type { PresentationConfig } from '@eudiplo/sdk-core';
import { decodeJwt } from 'jose';

export type RegistrationCertStatus =
  'none' | 'active' | 'expiring' | 'expired' | 'missing' | 'invalid' | 'notYetValid';

/** Issue, start and expiry time of a registration certificate JWT, in seconds since the epoch. */
export interface RegistrationCertTimes {
  issuedAt?: number;
  notBefore?: number;
  expiresAt?: number;
}

const EXPIRING_WINDOW_SECONDS = 7 * 24 * 60 * 60;

/**
 * Issue and expiry time of the configuration's registration certificate, read from its JWT.
 * Undefined without a JWT or when it cannot be decoded.
 */
export function getRegistrationCertTimes(
  config: Pick<PresentationConfig, 'registration_cert'> | null | undefined
): RegistrationCertTimes | undefined {
  const jwt = config?.registration_cert?.jwt;
  return jwt ? jwtTimes(jwt) : undefined;
}

/**
 * Display status of a presentation configuration's registration certificate:
 * valid and not yet expiring → active; within 7 days → expiring; past expiry
 * → expired; a JWT that cannot be decoded → invalid; a purpose or privacy
 * policy kept without a JWT → missing; no registration certificate settings
 * at all → none. EUDIPLO does not renew the certificate; a registrar such as
 * the EUDI Hub issues a new one on request.
 */
export function getRegistrationCertStatus(
  config: Pick<PresentationConfig, 'registration_cert'> | null | undefined
): RegistrationCertStatus {
  const spec = config?.registration_cert;
  if (!spec) return 'none';
  if (!spec.jwt) return spec.purpose?.length || spec.privacy_policy ? 'missing' : 'none';
  return jwtStatus(spec.jwt);
}

/**
 * Status of the issuer registration certificate of the issuance
 * configuration: none while it is turned off, missing without a JWT.
 */
export function getIssuerRegistrationCertStatus(
  settings: { enabled?: boolean; jwt?: string } | null | undefined
): RegistrationCertStatus {
  if (!settings?.enabled) return 'none';
  return settings.jwt ? jwtStatus(settings.jwt) : 'missing';
}

/**
 * Status of a registration certificate JWT by its `nbf` and `exp`: invalid
 * when it cannot be decoded, not yet valid before its `nbf` (wallets and
 * EUDIPLO refuse it until then), active without `exp`.
 */
export function jwtStatus(
  jwt: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): RegistrationCertStatus {
  const times = jwtTimes(jwt);
  if (!times) return 'invalid';
  if (typeof times.notBefore === 'number' && times.notBefore > nowSeconds) {
    return 'notYetValid';
  }
  const exp = times.expiresAt;
  if (typeof exp === 'number') {
    if (exp < nowSeconds) return 'expired';
    if (exp - nowSeconds < EXPIRING_WINDOW_SECONDS) return 'expiring';
  }
  return 'active';
}

/** Issue, start and expiry time of a JWT; undefined when it cannot be decoded. */
export function jwtTimes(jwt: string): RegistrationCertTimes | undefined {
  try {
    const { iat, nbf, exp } = decodeJwt(jwt);
    return { issuedAt: iat, notBefore: nbf, expiresAt: exp };
  } catch {
    return undefined;
  }
}

/**
 * What the status means and what to do next, for tooltips, status lines and
 * dashboard warnings. Undefined for `none`. With `canRequestFromEudiHub`
 * false (no registrar:manage role), the EUDI Hub is not suggested.
 */
export function registrationCertStatusSentence(
  status: RegistrationCertStatus,
  expiresIn?: string | null,
  { canRequestFromEudiHub = true }: { canRequestFromEudiHub?: boolean } = {}
): string | undefined {
  switch (status) {
    case 'active':
      return expiresIn ? `Active — expires in ${expiresIn}` : 'Active';
    case 'expiring':
      return `Expiring soon — ${expiresIn ?? 'a few days'} remaining; request a new one`;
    case 'expired':
      return 'Expired — request a new one or remove it';
    case 'missing':
      return canRequestFromEudiHub
        ? 'No certificate — request one from the EUDI Hub or paste a JWT'
        : 'No certificate — paste a JWT from a registrar';
    case 'invalid':
      return 'Not a valid JWT — request a new one or paste a valid JWT';
    case 'notYetValid':
      return 'Not yet valid — requests fail until its start time; check the date or request a new one';
    default:
      return undefined;
  }
}

export function formatRegistrationCertExpiresIn(
  times: RegistrationCertTimes | null | undefined
): string | null {
  const exp = times?.expiresAt;
  if (typeof exp !== 'number') return null;
  const seconds = exp - Math.floor(Date.now() / 1000);
  if (seconds <= 0) return 'expired';
  const days = Math.floor(seconds / 86400);
  if (days >= 1) return `${days} day${days === 1 ? '' : 's'}`;
  const hours = Math.floor(seconds / 3600);
  if (hours >= 1) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const mins = Math.floor(seconds / 60);
  return `${mins} minute${mins === 1 ? '' : 's'}`;
}
