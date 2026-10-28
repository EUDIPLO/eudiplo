export interface ClaimQuery {
  path: (string | number)[];
  id?: string;
  values?: string[];
  intent_to_retain?: boolean;
}

interface TrustListReference {
  trustListId?: string;
  url?: string;
  verifierX509Der?: string;
  verifierKey?: Record<string, unknown>;
}

export type TrustedAuthority =
  | { type: 'etsi_tl'; values: TrustListReference[] }
  | { type: 'openid_federation'; values: string[] };

export interface CredentialSetQuery {
  options: string[][];
  required?: boolean;
}

export interface SimpleCredentialQuery {
  id: string;
  format: 'dc+sd-jwt' | 'mso_mdoc';
  type: string;
  /** Empty means `claims` is omitted: only the credential itself is requested (OID4VP 1.0 §6.1). */
  claims: ClaimQuery[];
  trustedAuthorities?: TrustedAuthority[];
}

export interface SimpleDcql {
  credentials: SimpleCredentialQuery[];
  credentialSets?: CredentialSetQuery[];
}

const record = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const onlyKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const identifier = /^[A-Za-z0-9_-]+$/;

export function parseDcql(value: unknown): unknown {
  try {
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    return null;
  }
}

function supportedAuthorities(value: unknown): value is TrustedAuthority[] {
  return (
    Array.isArray(value) &&
    value.every((authority) => {
      if (
        !record(authority) ||
        !onlyKeys(authority, ['type', 'values']) ||
        !Array.isArray(authority['values'])
      )
        return false;
      if (authority['type'] === 'openid_federation')
        return authority['values'].every((entry) => typeof entry === 'string');
      return (
        authority['type'] === 'etsi_tl' &&
        authority['values'].every(
          (entry) =>
            record(entry) &&
            onlyKeys(entry, ['trustListId', 'url', 'verifierX509Der', 'verifierKey']) &&
            ['trustListId', 'url', 'verifierX509Der'].every(
              (key) => entry[key] === undefined || typeof entry[key] === 'string'
            ) &&
            (entry['verifierKey'] === undefined || record(entry['verifierKey']))
        )
      );
    })
  );
}

/** Unsupported features remain in JSON. Supported nested data is cloned without normalization. */
export function readSimpleDcql(value: unknown): SimpleDcql | null {
  if (value == null || value === '') return { credentials: [] };
  const query = parseDcql(value);
  if (!record(query) || !onlyKeys(query, ['credentials', 'credential_sets', '$schema']))
    return null;
  if (!Array.isArray(query['credentials']) || !query['credentials'].length) return null;
  if (
    query['credential_sets'] !== undefined &&
    (!Array.isArray(query['credential_sets']) ||
      !query['credential_sets'].every(
        (set) =>
          record(set) &&
          onlyKeys(set, ['options', 'required']) &&
          (set['required'] === undefined || typeof set['required'] === 'boolean') &&
          Array.isArray(set['options']) &&
          set['options'].every(
            (option) => Array.isArray(option) && option.every((id) => typeof id === 'string')
          )
      ))
  )
    return null;
  const credentials: SimpleCredentialQuery[] = [];
  for (const credential of query['credentials']) {
    if (
      !record(credential) ||
      !onlyKeys(credential, ['id', 'format', 'meta', 'claims', 'trusted_authorities']) ||
      typeof credential['id'] !== 'string' ||
      !record(credential['meta']) ||
      // An empty array stays in JSON, where dcqlReferenceError flags it.
      (credential['claims'] !== undefined &&
        (!Array.isArray(credential['claims']) || !credential['claims'].length))
    )
      return null;
    const format = credential['format'];
    const meta = credential['meta'];
    let type: string;
    if (format === 'dc+sd-jwt') {
      if (
        !onlyKeys(meta, ['vct_values']) ||
        !Array.isArray(meta['vct_values']) ||
        meta['vct_values'].length !== 1 ||
        typeof meta['vct_values'][0] !== 'string'
      )
        return null;
      type = meta['vct_values'][0];
    } else if (format === 'mso_mdoc') {
      if (!onlyKeys(meta, ['doctype_value']) || typeof meta['doctype_value'] !== 'string')
        return null;
      type = meta['doctype_value'];
    } else return null;
    const claims: any[] = credential['claims'] ?? [];
    if (
      !claims.every(
        (claim) =>
          record(claim) &&
          onlyKeys(
            claim,
            format === 'mso_mdoc'
              ? ['path', 'id', 'values', 'intent_to_retain']
              : ['path', 'id', 'values']
          ) &&
          Array.isArray(claim['path']) &&
          claim['path'].every(
            (part) =>
              typeof part === 'string' ||
              (typeof part === 'number' && Number.isInteger(part) && part >= 0)
          ) &&
          (claim['id'] === undefined || typeof claim['id'] === 'string') &&
          (claim['values'] === undefined ||
            (Array.isArray(claim['values']) &&
              claim['values'].every((v) => typeof v === 'string'))) &&
          (claim['intent_to_retain'] === undefined ||
            typeof claim['intent_to_retain'] === 'boolean')
      )
    )
      return null;
    if (
      credential['trusted_authorities'] !== undefined &&
      !supportedAuthorities(credential['trusted_authorities'])
    )
      return null;
    credentials.push({
      id: credential['id'],
      format,
      type,
      claims: structuredClone(claims),
      ...(credential['trusted_authorities'] !== undefined
        ? { trustedAuthorities: structuredClone(credential['trusted_authorities']) }
        : {}),
    });
  }
  return {
    credentials,
    ...(query['credential_sets'] !== undefined
      ? { credentialSets: structuredClone(query['credential_sets']) }
      : {}),
  };
}

export function buildSimpleDcql(query: SimpleDcql): object {
  return {
    credentials: query.credentials.map((credential) => ({
      id: credential.id,
      format: credential.format,
      meta:
        credential.format === 'dc+sd-jwt'
          ? { vct_values: [credential.type] }
          : { doctype_value: credential.type },
      // DCQL requires a non-empty `claims` array when present.
      ...(credential.claims.length ? { claims: structuredClone(credential.claims) } : {}),
      ...(credential.trustedAuthorities !== undefined
        ? { trusted_authorities: structuredClone(credential.trustedAuthorities) }
        : {}),
    })),
    ...(query.credentialSets !== undefined
      ? { credential_sets: structuredClone(query.credentialSets) }
      : {}),
  };
}

/** The ID of the first credential with `claims: []`, which OID4VP 1.0 §6.1 forbids. */
function emptyClaimsCredentialId(value: unknown): string | undefined {
  const query = parseDcql(value);
  if (!record(query) || !Array.isArray(query['credentials'])) return undefined;
  return query['credentials'].find(
    (credential) => Array.isArray(credential?.claims) && !credential.claims.length
  )?.id;
}

/** Whether `claims: []` is the only reason the visual builder cannot open the query. */
export function onlyEmptyClaimsUnsupported(value: unknown): boolean {
  const query = parseDcql(value);
  if (emptyClaimsCredentialId(query) === undefined || !record(query)) return false;
  return (
    readSimpleDcql({
      ...query,
      credentials: query['credentials'].map((credential: unknown) => {
        if (!record(credential) || !Array.isArray(credential['claims'])) return credential;
        if (credential['claims'].length) return credential;
        return Object.fromEntries(Object.entries(credential).filter(([key]) => key !== 'claims'));
      }),
    }) !== null
  );
}

/** Check references and empty claim lists in both visual and JSON modes, independently of mounted controls. */
export function dcqlReferenceError(value: unknown): string | null {
  const query = parseDcql(value);
  if (!record(query) || !Array.isArray(query['credentials'])) return null;
  const emptyClaims = emptyClaimsCredentialId(query);
  if (emptyClaims !== undefined)
    return `Credential "${emptyClaims}" has an empty claims list. Remove "claims" to request no claims.`;
  const ids = query['credentials'].map((credential) => credential?.id);
  if (new Set(ids).size !== ids.length) return 'Each credential needs a unique query ID.';
  if (!Array.isArray(query['credential_sets'])) return null;
  for (const [index, set] of query['credential_sets'].entries()) {
    if (!Array.isArray(set?.options)) continue;
    for (const option of set.options) {
      if (!Array.isArray(option)) continue;
      const missing = option.find((id) => !ids.includes(id));
      if (missing !== undefined)
        return `Requirement ${index + 1} references missing credential "${missing}". Select an existing credential or remove the option.`;
    }
  }
  return null;
}

export function claimError(
  claim: ClaimQuery,
  format: SimpleCredentialQuery['format']
): string | null {
  if (format !== 'mso_mdoc' && claim.intent_to_retain !== undefined)
    return 'Clear the mDOC retention option before using this claim with SD-JWT.';
  if (
    !claim.path.length ||
    claim.path.some((part) =>
      typeof part === 'string' ? !part.trim() : !Number.isInteger(part) || part < 0
    )
  )
    return 'Enter a claim path. Array indexes must be non-negative integers.';
  if (
    format === 'mso_mdoc' &&
    (claim.path.length !== 2 || claim.path.some((part) => typeof part !== 'string'))
  )
    return 'An mDOC claim needs a namespace and a claim name.';
  if (claim.id !== undefined && !identifier.test(claim.id))
    return 'Claim IDs can contain letters, numbers, underscores or hyphens.';
  if (claim.values !== undefined && !claim.values.length)
    return 'Add an allowed value or remove the value constraint.';
  return null;
}

function isUrl(value: string): boolean {
  try {
    return ['https:', 'http:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

export function trustError(authorities: TrustedAuthority[] | undefined): string | null {
  for (const authority of authorities ?? []) {
    if (!authority.values.length) return 'Add a trust reference or remove the empty authority.';
    if (authority.type === 'openid_federation') {
      if (authority.values.some((id) => !id.trim())) return 'Choose a federation trust anchor.';
      if (authority.values.some((id) => !isUrl(id)))
        return 'Choose a registered federation trust anchor, or fix the value in DCQL JSON.';
    } else {
      for (const ref of authority.values) {
        if (ref.trustListId !== undefined) {
          if (!ref.trustListId.trim()) return 'Select a managed trust list.';
        } else if (!ref.url || (!isUrl(ref.url) && !/^<TENANT_URL>(?:\/.*)?$/.test(ref.url)))
          return 'Enter the external trust-list URL.';
      }
    }
  }
  return null;
}

export function simpleDcqlError(query: SimpleDcql): string | null {
  if (!query.credentials.length) return 'Add a credential to request.';
  for (const credential of query.credentials) {
    if (!identifier.test(credential.id))
      return 'Use letters, numbers, underscores or hyphens for the query ID.';
    if (!credential.type.trim()) return 'Enter the credential type.';
    const seenClaims = new Set<string>();
    for (const claim of credential.claims) {
      const error = claimError(claim, credential.format);
      if (error) return error;
      if (claim.id && seenClaims.has(claim.id))
        return 'Claim IDs must be unique within a credential.';
      if (claim.id) seenClaims.add(claim.id);
    }
    const error = trustError(credential.trustedAuthorities);
    if (error) return error;
  }
  if (query.credentialSets !== undefined) {
    if (!query.credentialSets.length)
      return 'Add a requirement or choose Require all selected credentials.';
    for (const set of query.credentialSets) {
      if (!set.options.length || set.options.some((option) => !option.length))
        return 'Select at least one credential in every alternative.';
    }
  }
  return dcqlReferenceError(buildSimpleDcql(query));
}

export function trustSummary(authorities: TrustedAuthority[] | undefined): string {
  if (!authorities?.length) return 'No issuer trust constraint configured';
  return authorities
    .flatMap((authority) =>
      authority.type === 'openid_federation'
        ? authority.values.map((id) => `Federation: ${id || 'Not selected'}`)
        : authority.values.map(
            (ref) => `Trust list: ${ref.trustListId || ref.url || 'Not selected'}`
          )
    )
    .join(' · ');
}
