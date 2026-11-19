import type { NormalizedCredential } from '../issuer-metadata-browser/issuer-metadata.service';
import type { ClaimQuery, SimpleCredentialQuery } from './simple-dcql';

/**
 * Hints from the credential configs this tenant issues, for the DCQL builder.
 * They only suggest and warn: a verifier usually asks for credentials issued
 * elsewhere, so a type or claim that no local config has is never an error.
 */

/** The type a credential config issues: its vct for SD-JWT VC, its doctype for mDOC. */
function issuedType(credential: NormalizedCredential): string | undefined {
  return credential.format === 'mso_mdoc' ? credential.doctype : credential.vct;
}

/** The credential configs of this tenant that issue the query's format and type. */
export function matchingConfigs(
  query: Pick<SimpleCredentialQuery, 'format' | 'type'>,
  known: readonly NormalizedCredential[]
): NormalizedCredential[] {
  const type = query.type.trim();
  if (!type) return [];
  return known.filter(
    (credential) => credential.format === query.format && issuedType(credential) === type
  );
}

/** One suggestion for the type field: the value to enter and which config issues it. */
export interface TypeOption {
  value: string;
  label: string;
}

/** The types this tenant issues in a format, once each, for the type field. */
export function typeOptions(
  format: SimpleCredentialQuery['format'],
  known: readonly NormalizedCredential[]
): TypeOption[] {
  const options = new Map<string, TypeOption>();
  for (const credential of known) {
    const value = credential.format === format ? issuedType(credential) : undefined;
    if (!value || options.has(value)) continue;
    const name =
      credential.displayName === credential.id
        ? credential.id
        : `${credential.displayName} (${credential.id})`;
    options.set(value, { value, label: name });
  }
  return [...options.values()];
}

/** Paths of the claims the matching configs publish, without duplicates. */
function publishedPaths(configs: readonly NormalizedCredential[]): (string | null)[][] {
  const seen = new Set<string>();
  const paths: (string | null)[][] = [];
  for (const config of configs) {
    for (const claim of config.claims) {
      const key = JSON.stringify(claim.path);
      if (seen.has(key)) continue;
      seen.add(key);
      paths.push(claim.path);
    }
  }
  return paths;
}

/** A segment the dotted Claim path field keeps as one segment (as `usesSegments` decides). */
const DOT_SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;

/**
 * Claim paths to suggest for an SD-JWT VC claim, written with dots as the
 * Claim path field takes them. Paths through array elements, and names the
 * field would split or cannot hold (a dot, a colon), are left out: picking
 * them would ask for a different claim.
 */
export function sdJwtClaimOptions(configs: readonly NormalizedCredential[]): string[] {
  return publishedPaths(configs)
    .filter((path) => path.every((part) => typeof part === 'string' && DOT_SAFE_SEGMENT.test(part)))
    .map((path) => path.join('.'));
}

/** Claim names to suggest for an mDOC claim in a namespace. */
export function mdocClaimOptions(
  configs: readonly NormalizedCredential[],
  namespace: string
): string[] {
  return publishedPaths(configs)
    .filter((path) => path.length === 2 && path[0] === namespace && typeof path[1] === 'string')
    .map((path) => path[1] as string);
}

/** The namespaces the matching mDOC configs publish claims in. */
export function mdocNamespaceOptions(configs: readonly NormalizedCredential[]): string[] {
  return [
    ...new Set(
      publishedPaths(configs)
        .map((path) => path[0])
        .filter((part): part is string => typeof part === 'string')
    ),
  ];
}

/**
 * Whether a claim of the query is missing from every matching config. A path
 * counts as published when it equals a published path, lies inside one (a
 * nested claim of a published object) or contains one (an object whose
 * nested claims are published). Paths with array indexes, empty segments or
 * nothing to compare against are not flagged, nor, while the user is
 * `typing` in the field, a last segment that starts a published name.
 */
export function isUnpublishedClaim(
  claim: ClaimQuery,
  configs: readonly NormalizedCredential[],
  { typing = false }: { typing?: boolean } = {}
): boolean {
  if (configs.length === 0) return false;
  const path = claim.path;
  if (path.length === 0 || path.some((part) => typeof part !== 'string' || part === '')) {
    return false;
  }
  const published = publishedPaths(configs);
  if (published.length === 0) return false;
  const last = path.length - 1;
  return !published.some((candidate) => {
    const shorter = Math.min(candidate.length, path.length);
    for (let i = 0; i < shorter; i++) {
      if (candidate[i] === null || candidate[i] === path[i]) continue;
      // A last segment that starts a published name is still being typed.
      const unfinished =
        typing && i === last && (candidate[i] as string).startsWith(path[i] as string);
      if (!unfinished) return false;
    }
    return true;
  });
}

/** "credential config "pid"" or "credential configs "pid" and "pid-2"", for hint sentences. */
export function configNames(configs: readonly NormalizedCredential[]): string {
  const ids = configs.map((config) => `"${config.id}"`);
  if (ids.length <= 1) return `credential config ${ids.join('')}`;
  return `credential configs ${ids.slice(0, -1).join(', ')} and ${ids.at(-1)}`;
}
