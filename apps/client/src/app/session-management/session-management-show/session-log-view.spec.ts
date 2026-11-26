import { describe, expect, it } from 'vitest';
import type { SessionLogEntry } from '../session-management.service';
import { sessionLogView } from './session-log-view';

function entry(message: string, detail?: Record<string, unknown>): SessionLogEntry {
  return {
    id: 'log-1',
    sessionId: 'session-1',
    timestamp: '2026-11-26T15:49:27Z',
    level: 'error',
    message,
    detail,
  };
}

describe('sessionLogView', () => {
  it('shows the error name apart, drops the repeated message and keeps the stack separate', () => {
    const view = sessionLogView(
      entry('[OID4VP] Flow error for session s1: Status is not valid', {
        errorName: 'SdJwtError',
        errorMessage: 'Status is not valid',
        errorStack: 'SdJwtError: Status is not valid\n    at checkStatusListEntry',
        action: 'process_presentation_response',
      })
    );

    expect(view.errorName).toBe('SdJwtError');
    expect(view.stack).toBe('SdJwtError: Status is not valid\n    at checkStatusListEntry');
    expect(view.fields).toEqual([{ key: 'action', value: 'process_presentation_response' }]);
    expect(view.extra).toBeUndefined();
  });

  it('keeps errorMessage when the message line does not carry it', () => {
    const view = sessionLogView(entry('Flow failed', { errorMessage: 'Status is not valid' }));

    expect(view.fields).toEqual([{ key: 'errorMessage', value: 'Status is not valid' }]);
  });

  it('lists scalar values as fields and puts objects behind Details', () => {
    const view = sessionLogView(
      entry('Flow started', {
        hasWebhook: false,
        attempts: 2,
        skipped: null,
        claims: { given_name: 'Erika' },
      })
    );

    expect(view.fields).toEqual([
      { key: 'hasWebhook', value: 'false' },
      { key: 'attempts', value: '2' },
    ]);
    expect(view.extra).toBe(JSON.stringify({ claims: { given_name: 'Erika' } }, null, 2));
  });

  it('lists an errorName or errorStack that is not a string as an ordinary value', () => {
    const view = sessionLogView(entry('Flow failed', { errorName: 42, errorStack: ['frame'] }));

    expect(view.errorName).toBeUndefined();
    expect(view.stack).toBeUndefined();
    expect(view.fields).toEqual([{ key: 'errorName', value: '42' }]);
    expect(view.extra).toBe(JSON.stringify({ errorStack: ['frame'] }, null, 2));
  });

  it('keeps an empty errorMessage', () => {
    const view = sessionLogView(entry('Flow failed', { errorMessage: '' }));

    expect(view.fields).toEqual([{ key: 'errorMessage', value: '' }]);
  });

  it('returns no fields for an entry without detail', () => {
    expect(sessionLogView(entry('Flow completed'))).toEqual({ fields: [] });
  });
});
