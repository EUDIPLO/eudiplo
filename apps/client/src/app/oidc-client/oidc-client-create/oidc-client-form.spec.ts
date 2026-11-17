import { FormArray, FormControl, FormGroup } from '@angular/forms';
import { describe, expect, it } from 'vitest';

import {
  anyCredentialQueryIds,
  commonCredentialQueryIds,
  redirectUriProblem,
  scopeNameProblem,
  uniqueValuesValidator,
} from './oidc-client-form';

const config = (id: string, queries: string[]) =>
  ({
    id,
    dcql_query: { credentials: queries.map((q) => ({ id: q, format: 'dc+sd-jwt' })) },
  }) as never;

describe('redirectUriProblem', () => {
  it('accepts HTTPS and HTTP on loopback hosts', () => {
    expect(redirectUriProblem('https://app.example.com/cb')).toBe('');
    expect(redirectUriProblem('http://localhost:3000/cb')).toBe('');
    expect(redirectUriProblem('http://127.0.0.1/cb')).toBe('');
    expect(redirectUriProblem('http://[::1]/cb')).toBe('');
  });

  it('refuses HTTP elsewhere, fragments, user information and relative URIs', () => {
    expect(redirectUriProblem('http://app.example.com/cb')).toContain('HTTPS');
    expect(redirectUriProblem('https://app.example.com/cb#x')).toContain('fragment');
    expect(redirectUriProblem('https://u:p@app.example.com/cb')).toContain('user name');
    expect(redirectUriProblem('/cb')).toContain('absolute');
  });
});

describe('scopeNameProblem', () => {
  it('reserves openid and checks the characters', () => {
    expect(scopeNameProblem('pid')).toBe('');
    expect(scopeNameProblem('eu.europa:pid_1-x')).toBe('');
    expect(scopeNameProblem('openid')).toContain('reserved');
    expect(scopeNameProblem('has space')).not.toBe('');
    expect(scopeNameProblem('a'.repeat(65))).not.toBe('');
  });
});

describe('uniqueValuesValidator', () => {
  it('marks every duplicate row and clears the mark once it is unique', () => {
    const rows = new FormArray(
      [
        new FormGroup({ scope: new FormControl('pid') }),
        new FormGroup({ scope: new FormControl('pid') }),
      ],
      [uniqueValuesValidator('scope', 'twice')]
    );

    expect(rows.hasError('duplicate')).toBe(true);
    expect(rows.at(0).get('scope')?.getError('duplicate')).toBe('twice');
    expect(rows.at(1).get('scope')?.getError('duplicate')).toBe('twice');

    rows.at(1).get('scope')?.setValue('age');

    expect(rows.valid).toBe(true);
    expect(rows.at(0).get('scope')?.errors).toBeNull();
  });
});

describe('credential query IDs', () => {
  const a = config('a', ['pid', 'mdl']);
  const b = config('b', ['pid', 'age']);

  it('offers for the subject only the queries every config has', () => {
    expect(commonCredentialQueryIds([a, b])).toEqual(['pid']);
    expect(commonCredentialQueryIds([])).toEqual([]);
    expect(commonCredentialQueryIds([a, undefined])).toEqual([]);
  });

  it('offers for the top-level claims the queries of any config', () => {
    expect(anyCredentialQueryIds([a, b])).toEqual(['pid', 'mdl', 'age']);
  });
});
