import { describe, expect, it } from 'vitest';
import type { NormalizedCredential } from '../issuer-metadata-browser/issuer-metadata.service';
import {
  configNames,
  isUnpublishedClaim,
  matchingConfigs,
  mdocClaimOptions,
  mdocNamespaceOptions,
  sdJwtClaimOptions,
  typeOptions,
} from './credential-config-hints';

const pid: NormalizedCredential = {
  id: 'pid',
  format: 'dc+sd-jwt',
  displayName: 'PID',
  vct: 'urn:eudi:pid:de:1',
  claims: [
    { path: ['given_name'], displayName: 'Given name', mandatory: false },
    { path: ['address', 'locality'], displayName: 'Locality', mandatory: false },
    {
      path: ['nationalities', null as unknown as string],
      displayName: 'Nationality',
      mandatory: false,
    },
  ],
};
const pidKey: NormalizedCredential = { ...pid, id: 'pid-key', claims: [] };
const mdl: NormalizedCredential = {
  id: 'mdl',
  format: 'mso_mdoc',
  displayName: 'mdl',
  doctype: 'org.iso.18013.5.1.mDL',
  claims: [
    {
      path: ['org.iso.18013.5.1', 'family_name'],
      namespace: 'org.iso.18013.5.1',
      displayName: 'Family name',
      mandatory: false,
    },
  ],
};
const known = [pid, pidKey, mdl];

describe('hints from the credential configs of the tenant', () => {
  it('matches a query by format and exact type only', () => {
    expect(matchingConfigs({ format: 'dc+sd-jwt', type: ' urn:eudi:pid:de:1 ' }, known)).toEqual([
      pid,
      pidKey,
    ]);
    expect(matchingConfigs({ format: 'mso_mdoc', type: 'urn:eudi:pid:de:1' }, known)).toEqual([]);
    expect(matchingConfigs({ format: 'dc+sd-jwt', type: 'urn:eudi:pid' }, known)).toEqual([]);
    expect(matchingConfigs({ format: 'dc+sd-jwt', type: '' }, known)).toEqual([]);
  });

  it('suggests each issued type of a format once, named by its config', () => {
    expect(typeOptions('dc+sd-jwt', known)).toEqual([
      { value: 'urn:eudi:pid:de:1', label: 'PID (pid)' },
    ]);
    expect(typeOptions('mso_mdoc', known)).toEqual([
      { value: 'org.iso.18013.5.1.mDL', label: 'mdl' },
    ]);
  });

  it('suggests claim paths with dots, leaving out paths through array elements', () => {
    expect(sdJwtClaimOptions([pid])).toEqual(['given_name', 'address.locality']);
  });

  it('suggests mDOC namespaces and the claim names in one', () => {
    expect(mdocNamespaceOptions([mdl])).toEqual(['org.iso.18013.5.1']);
    expect(mdocClaimOptions([mdl], 'org.iso.18013.5.1')).toEqual(['family_name']);
    expect(mdocClaimOptions([mdl], 'other')).toEqual([]);
  });

  it('flags a claim no matching config publishes, and nothing it cannot judge', () => {
    const flagged = (path: (string | number)[]) => isUnpublishedClaim({ path }, [pid]);
    expect(flagged(['birth_date'])).toBe(true);
    expect(flagged(['address', 'street'])).toBe(true);
    // Published, inside a published object, or an object with published claims.
    expect(flagged(['given_name'])).toBe(false);
    expect(flagged(['address'])).toBe(false);
    expect(flagged(['nationalities', 'x'])).toBe(false);
    // Array indexes, unfinished paths and no matching config are not judged.
    expect(flagged(['nationalities', 0])).toBe(false);
    expect(flagged([''])).toBe(false);
    expect(isUnpublishedClaim({ path: ['birth_date'] }, [])).toBe(false);
    expect(isUnpublishedClaim({ path: ['birth_date'] }, [pidKey])).toBe(false);
  });

  it('flags an mDOC claim in the wrong namespace', () => {
    expect(isUnpublishedClaim({ path: ['org.iso.18013.5.1', 'family_name'] }, [mdl])).toBe(false);
    expect(isUnpublishedClaim({ path: ['other', 'family_name'] }, [mdl])).toBe(true);
  });

  it('suggests no claim name the dotted field would split or cannot hold', () => {
    const dotted: NormalizedCredential = {
      ...pid,
      claims: [
        { path: ['eu.example.age'], displayName: 'Age', mandatory: false },
        { path: ['urn:x'], displayName: 'URN', mandatory: false },
        { path: ['age_over_18'], displayName: 'Over 18', mandatory: false },
      ],
    };
    expect(sdJwtClaimOptions([dotted])).toEqual(['age_over_18']);
  });

  it('does not flag a claim name while it is still being typed, but does once it is left', () => {
    const typing = { typing: true };
    expect(isUnpublishedClaim({ path: ['given_na'] }, [pid], typing)).toBe(false);
    expect(isUnpublishedClaim({ path: ['address', 'loc'] }, [pid], typing)).toBe(false);
    expect(isUnpublishedClaim({ path: ['giv', 'x'] }, [pid], typing)).toBe(true);
    expect(isUnpublishedClaim({ path: ['given_na'] }, [pid])).toBe(true);
  });

  it('names one, two or more credential configs', () => {
    expect(configNames([pid])).toBe('credential config "pid"');
    expect(configNames([pid, pidKey])).toBe('credential configs "pid" and "pid-key"');
    expect(configNames([pid, pidKey, mdl])).toBe('credential configs "pid", "pid-key" and "mdl"');
  });
});
