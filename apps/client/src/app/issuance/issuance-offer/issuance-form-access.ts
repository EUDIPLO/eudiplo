import type { Role } from '../../services/jwt.service';

/**
 * New Issuance sends the offer with `issuance:offer`, but builds its form from the credential
 * configs, the issuer settings and the attribute providers, which the backend only shows to
 * `issuance:manage`. A caller with `issuance:offer` alone cannot load it, so its entry points
 * are hidden or locked with this reason instead of leading to a page that cannot load.
 */
export const ISSUANCE_FORM_LOCKED_REASON =
  'New Issuance also needs the issuance:manage role: the form reads the credential configs and the issuer settings. With issuance:offer alone, create offers through the API.';

/** Whether the caller can use New Issuance: create offers and read what the form needs. */
export function canUseIssuanceForm(hasRole: (role: Role) => boolean): boolean {
  return hasRole('issuance:offer') && hasRole('issuance:manage');
}
