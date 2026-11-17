import { describe, expect, it } from 'vitest';
import {
  formatRegistrationCertExpiresIn,
  getIssuerRegistrationCertStatus,
  getRegistrationCertStatus,
  getRegistrationCertTimes,
  jwtStatus,
  registrationCertStatusSentence,
} from './registration-cert-status';

/** An unsigned JWT with this payload; only its claims are read. */
function jwt(payload: Record<string, unknown>): string {
  const part = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${part({ alg: 'ES256' })}.${part(payload)}.c2ln`;
}

const now = () => Math.floor(Date.now() / 1000);
const DAY = 24 * 60 * 60;

describe('getRegistrationCertStatus', () => {
  const withCert = (registration_cert: unknown) =>
    getRegistrationCertStatus({ registration_cert } as never);

  it('is none without registration certificate settings', () => {
    expect(getRegistrationCertStatus(undefined)).toBe('none');
    expect(withCert(null)).toBe('none');
    expect(withCert({})).toBe('none');
  });

  it('is missing when a purpose or privacy policy is kept without a JWT', () => {
    expect(withCert({ purpose: [{ lang: 'en', content: 'Age check' }] })).toBe('missing');
    expect(withCert({ privacy_policy: 'https://verifier.example/privacy' })).toBe('missing');
  });

  it('is active, expiring or expired by the exp of the JWT', () => {
    expect(withCert({ jwt: jwt({ exp: now() + 30 * DAY }) })).toBe('active');
    expect(withCert({ jwt: jwt({ exp: now() + 2 * DAY }) })).toBe('expiring');
    expect(withCert({ jwt: jwt({ exp: now() - 60 }) })).toBe('expired');
  });

  it('is active for a JWT without exp', () => {
    expect(withCert({ jwt: jwt({ iat: now() }) })).toBe('active');
  });

  it('is invalid for a JWT that cannot be decoded, never active', () => {
    expect(withCert({ jwt: 'not-a-jwt' })).toBe('invalid');
    expect(withCert({ jwt: 'a.b.c' })).toBe('invalid');
  });
});

describe('getIssuerRegistrationCertStatus', () => {
  it('is none while turned off, missing without a JWT, else by the JWT', () => {
    expect(getIssuerRegistrationCertStatus(undefined)).toBe('none');
    expect(getIssuerRegistrationCertStatus({ enabled: false, jwt: 'a.b.c' })).toBe('none');
    expect(getIssuerRegistrationCertStatus({ enabled: true })).toBe('missing');
    expect(getIssuerRegistrationCertStatus({ enabled: true, jwt: 'x' })).toBe('invalid');
    expect(
      getIssuerRegistrationCertStatus({ enabled: true, jwt: jwt({ exp: now() + 2 * DAY }) })
    ).toBe('expiring');
  });
});

describe('jwtStatus', () => {
  it('is not yet valid before nbf, never active', () => {
    const token = jwt({ nbf: 2_000_000, exp: 3_000_000 });
    expect(jwtStatus(token, 1_999_999)).toBe('notYetValid');
    expect(jwtStatus(token, 2_000_000)).toBe('active');
    expect(
      getRegistrationCertStatus({ registration_cert: { jwt: jwt({ nbf: now() + DAY }) } })
    ).toBe('notYetValid');
  });

  it('compares exp with the given time', () => {
    const token = jwt({ exp: 1_000_000 });
    expect(jwtStatus(token, 1_000_000 - 30 * DAY)).toBe('active');
    expect(jwtStatus(token, 1_000_000 - DAY)).toBe('expiring');
    expect(jwtStatus(token, 1_000_001)).toBe('expired');
  });
});

describe('getRegistrationCertTimes', () => {
  it('reads iat and exp, and nothing from an invalid JWT', () => {
    expect(
      getRegistrationCertTimes({ registration_cert: { jwt: jwt({ iat: 1, exp: 2 }) } })
    ).toEqual({ issuedAt: 1, notBefore: undefined, expiresAt: 2 });
    expect(getRegistrationCertTimes({ registration_cert: { jwt: 'x' } })).toBeUndefined();
    expect(getRegistrationCertTimes({ registration_cert: {} })).toBeUndefined();
  });
});

describe('registrationCertStatusSentence', () => {
  it('names the next step for each status that needs one', () => {
    expect(registrationCertStatusSentence('active', '3 days')).toBe('Active — expires in 3 days');
    expect(registrationCertStatusSentence('expiring', '3 days')).toContain('request a new one');
    expect(registrationCertStatusSentence('expired')).toContain('request a new one');
    expect(registrationCertStatusSentence('missing')).toContain('EUDI Hub');
    expect(registrationCertStatusSentence('invalid')).toContain('Not a valid JWT');
    expect(registrationCertStatusSentence('notYetValid')).toContain('Not yet valid');
    expect(registrationCertStatusSentence('none')).toBeUndefined();
  });

  it('does not suggest the EUDI Hub without the registrar:manage role', () => {
    expect(registrationCertStatusSentence('missing', null, { canRequestFromEudiHub: false })).toBe(
      'No certificate — paste a JWT from a registrar'
    );
  });
});

describe('formatRegistrationCertExpiresIn', () => {
  it('says how long is left', () => {
    expect(formatRegistrationCertExpiresIn({ expiresAt: now() + 2 * DAY + 60 })).toBe('2 days');
    expect(formatRegistrationCertExpiresIn({ expiresAt: now() - 1 })).toBe('expired');
    expect(formatRegistrationCertExpiresIn({})).toBeNull();
  });
});
