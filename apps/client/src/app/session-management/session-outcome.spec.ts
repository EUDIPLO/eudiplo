import type { Session } from '@eudiplo/sdk-core';
import { describe, expect, it } from 'vitest';

import {
  isFinishedSession,
  sessionResult,
  sessionStatusClass,
  sessionStatusLabel,
} from './session-outcome';

type ResultInput = Parameters<typeof sessionResult>[0];
const session = (fields: Partial<Session>) => fields as ResultInput;

describe('sessionResult', () => {
  it('is null while the session is pending', () => {
    expect(sessionResult(session({ status: 'active' }))).toBeNull();
    expect(sessionResult(session({ status: 'fetched' }))).toBeNull();
  });

  it("shows the wallet's own text for a wallet error and asks to check the request", () => {
    const result = sessionResult(
      session({
        status: 'failed',
        requestId: 'check-in',
        errorReason: 'Wallet error: invalid_request: MissingRequiredRegistrationCertificate',
        failureCode: 'invalid_request',
        outcome: {
          result: 'failed',
          source: 'wallet',
          error: 'invalid_request',
          message: 'Wallet error: invalid_request: MissingRequiredRegistrationCertificate',
          description: 'MissingRequiredRegistrationCertificate',
        },
      })
    );

    expect(result).toMatchObject({
      tone: 'error',
      title: 'The wallet rejected the request',
      message: null,
      walletDescription: 'MissingRequiredRegistrationCertificate',
      code: 'invalid_request',
      checkRequest: true,
    });
  });

  it('keeps the message of a wallet error without a description', () => {
    const result = sessionResult(
      session({
        status: 'failed',
        requestId: 'check-in',
        outcome: {
          result: 'failed',
          source: 'wallet',
          error: 'vp_formats_not_supported',
          message: 'Wallet error: vp_formats_not_supported',
        },
      })
    );

    expect(result).toMatchObject({
      message: 'Wallet error: vp_formats_not_supported',
      walletDescription: null,
      code: 'vp_formats_not_supported',
    });
  });

  it('says the user declined, without asking to check the request', () => {
    const result = sessionResult(
      session({
        status: 'failed',
        requestId: 'check-in',
        failureCode: 'access_denied',
        outcome: { result: 'failed', source: 'wallet', error: 'access_denied' },
      })
    );

    expect(result).toMatchObject({
      title: 'The user declined the request in the wallet',
      message: null,
      checkRequest: false,
    });
  });

  it.each([
    ['credential_deleted', 'The wallet user rejected the credential'],
    ['credential_failure', 'The wallet could not store the credential'],
  ])("titles the wallet's %s notification of an issuance with its message", (code, title) => {
    const result = sessionResult(
      session({
        status: 'failed',
        failureCode: code,
        outcome: {
          result: 'failed',
          source: 'wallet',
          error: code,
          message: title,
          description: 'Why',
        },
      })
    );

    expect(result).toMatchObject({
      tone: 'error',
      title,
      walletDescription: 'Why',
      checkRequest: false,
    });
    expect(result?.message).toContain('Revoke it under Credential Status');
  });

  it('shows the verifier message and falls back to the outcome error code', () => {
    const result = sessionResult(
      session({
        status: 'failed',
        requestId: 'age',
        errorReason: 'older text',
        outcome: {
          result: 'failed',
          source: 'verifier',
          error: 'trust_chain_not_trusted',
          message: 'Not trusted',
        },
      })
    );

    expect(result).toMatchObject({
      title: 'Verification failed',
      message: 'Not trusted',
      code: 'trust_chain_not_trusted',
      checkRequest: false,
    });
  });

  it('falls back to errorReason when there is no outcome', () => {
    expect(sessionResult(session({ status: 'failed', errorReason: 'Broke' }))).toMatchObject({
      title: 'Issuance failed',
      message: 'Broke',
      code: null,
    });
  });

  it('names a finished issuance and presentation', () => {
    expect(sessionResult(session({ status: 'completed' }))?.title).toBe('Credentials issued');
    expect(sessionResult(session({ status: 'completed', requestId: 'x' }))?.title).toBe(
      'Verification succeeded'
    );
  });

  it('explains an expiry and names a cancellation', () => {
    expect(sessionResult(session({ status: 'expired', requestId: 'x' }))?.message).toBe(
      'No wallet answered the request before it expired.'
    );
    expect(sessionResult(session({ status: 'expired' }))?.title).toBe('Session expired');
    expect(sessionResult(session({ status: 'expired', consumed: true }))?.title).toBe(
      'Credentials issued, not confirmed'
    );
    expect(sessionResult(session({ status: 'cancelled' }))).toMatchObject({
      tone: 'neutral',
      title: 'Session cancelled',
      message: 'It was cancelled before a wallet redeemed the offer. No reason was given.',
      cancelReason: null,
    });
  });

  it('says a cancelled presentation request had no answer yet', () => {
    expect(
      sessionResult(session({ status: 'cancelled', requestId: 'age-check' }))?.message
    ).toMatch(/^It was cancelled before a wallet answered the request\./);
  });

  it('falls back to a generic title for a wallet notification without message or description', () => {
    expect(
      sessionResult(
        session({
          status: 'failed',
          outcome: { result: 'failed', source: 'wallet', error: 'credential_failure' },
        })
      )
    ).toMatchObject({ title: 'The wallet reported an error', walletDescription: null });
  });

  it('shows the reason the operator gave for a cancellation', () => {
    expect(
      sessionResult(session({ status: 'cancelled', cancelReason: 'Sent to the wrong person' }))
    ).toMatchObject({
      message: 'It was cancelled before a wallet redeemed the offer.',
      cancelReason: 'Sent to the wrong person',
    });
  });

  it('has a result exactly for the finished statuses', () => {
    for (const status of ['active', 'fetched', 'completed', 'expired', 'failed', 'cancelled']) {
      expect(!!sessionResult(session({ status: status as Session['status'] }))).toBe(
        isFinishedSession(status)
      );
    }
  });
});

describe('sessionStatusLabel', () => {
  it('capitalizes known statuses and keeps unknown ones', () => {
    expect(sessionStatusLabel('failed')).toBe('Failed');
    expect(sessionStatusLabel('active')).toBe('Active');
    expect(sessionStatusLabel(undefined)).toBe('Unknown');
    expect(sessionStatusLabel('weird')).toBe('weird');
  });
});

describe('sessionStatusClass', () => {
  it('names the badge tone of a status and nothing for a status that is not a string', () => {
    expect(sessionStatusClass('failed')).toBe('status-failed');
    expect(sessionStatusClass('fetched')).toBe('status-fetched');
    expect(sessionStatusClass({ status: 'failed' })).toBe('');
  });
});
