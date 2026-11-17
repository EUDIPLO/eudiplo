import type { AbstractControl, ValidationErrors, ValidatorFn } from '@angular/forms';
import type { PresentationConfig } from '@eudiplo/sdk-core';

// Copies of the backend's rules in apps/backend/src/verifier/oidc-provider/domain/oidc-client.ts
// and schemas/oidc-client.schema.ts; change them together.

/** Limits the backend enforces on a client. */
export const MAX_REDIRECT_URIS = 20;
export const MAX_SCOPES = 20;
export const MAX_SECRETS = 2;

/** Labels of the profiles, the same on every screen. */
export const PROFILE_LABELS: Record<'secure' | 'basic', string> = {
  secure: 'Secure (PAR required)',
  basic: 'Basic',
};

/** Scope names the backend accepts; `openid` is reserved. */
const SCOPE_NAME = /^[A-Za-z0-9_.:-]{1,64}$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Why a redirect URI cannot be registered, or '' when it can: an absolute
 * HTTPS URI without fragment or user information, or HTTP on a loopback host.
 * The same rule as the backend's `redirectUriProblem`.
 */
export function redirectUriProblem(uri: string): string {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return 'Enter an absolute URI, such as https://app.example.com/callback';
  }
  if (url.hash || uri.includes('#')) return 'A redirect URI must not contain a fragment (#)';
  if (url.username || url.password) return 'A redirect URI must not contain a user name';
  if (url.protocol === 'https:') return '';
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return '';
  return 'Use HTTPS; HTTP only for localhost, 127.0.0.1 and [::1]';
}

/** Fails a value that is empty once trimmed, which `Validators.required` lets through. */
export const notBlankValidator: ValidatorFn = (control) =>
  typeof control.value === 'string' && control.value.trim() === '' ? { required: true } : null;

export const redirectUriValidator: ValidatorFn = (control) => {
  const value = typeof control.value === 'string' ? control.value.trim() : '';
  if (!value) return null;
  const problem = redirectUriProblem(value);
  return problem ? { redirectUri: problem } : null;
};

/** Why a scope name cannot be used, or '' when it can. */
export function scopeNameProblem(scope: string): string {
  if (scope === 'openid') return '`openid` is reserved; every sign-in requests it';
  if (!SCOPE_NAME.test(scope)) return 'Letters, digits and _ . : - only, at most 64 characters';
  return '';
}

export const scopeNameValidator: ValidatorFn = (control) => {
  const value = typeof control.value === 'string' ? control.value.trim() : '';
  if (!value) return null;
  const problem = scopeNameProblem(value);
  return problem ? { scopeName: problem } : null;
};

/**
 * Flags a value that occurs in more than one control of a list: `field` names
 * the control of each row (or none for a list of plain controls). The error
 * is set on the rows, so each duplicate shows it.
 */
export function uniqueValuesValidator(field: string | null, message: string): ValidatorFn {
  return (list: AbstractControl): ValidationErrors | null => {
    const rows = (list as { controls?: AbstractControl[] }).controls ?? [];
    const controls = rows.map((row) => (field ? row.get(field) : row)).filter((c) => !!c);
    const counts = new Map<string, number>();
    for (const control of controls) {
      const value = String(control.value ?? '').trim();
      if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    let duplicate = false;
    for (const control of controls) {
      const value = String(control.value ?? '').trim();
      const isDuplicate = !!value && (counts.get(value) ?? 0) > 1;
      duplicate ||= isDuplicate;
      const others = { ...control.errors };
      delete others['duplicate'];
      if (isDuplicate) control.setErrors({ ...others, duplicate: message });
      else if (control.hasError('duplicate'))
        control.setErrors(Object.keys(others).length ? others : null);
    }
    return duplicate ? { duplicate: message } : null;
  };
}

/** The IDs of a presentation config's credential queries. */
export function credentialQueryIds(config: PresentationConfig | undefined): string[] {
  return (config?.dcql_query?.credentials ?? [])
    .map((query) => query.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/**
 * Credential query IDs for the subject: only those every selected config has,
 * since a sign-in with any scope must be able to provide the claim.
 */
export function commonCredentialQueryIds(configs: (PresentationConfig | undefined)[]): string[] {
  const [first, ...rest] = configs;
  if (!first) return [];
  return credentialQueryIds(first).filter((id) =>
    rest.every((config) => credentialQueryIds(config).includes(id))
  );
}

/**
 * Whether the credential query of every config names a trusted authority with a value, which the
 * backend requires of a subject query, so nobody can present a self-issued credential with
 * another person's value.
 */
export function hasTrustedAuthorities(
  configs: (PresentationConfig | undefined)[],
  credentialId: string
): boolean {
  return configs.every((config) =>
    (config?.dcql_query?.credentials ?? []).some(
      (query) =>
        query.id === credentialId &&
        (query.trusted_authorities ?? []).some((authority) => authority.values?.length > 0)
    )
  );
}

/** Credential query IDs of any selected config, for the top-level claims. */
export function anyCredentialQueryIds(configs: (PresentationConfig | undefined)[]): string[] {
  return [...new Set(configs.flatMap((config) => credentialQueryIds(config)))];
}
