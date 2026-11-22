import type { Session } from '@eudiplo/sdk-core';
import { describe, expect, it } from 'vitest';

import { DELETED_SESSION_CREDENTIALS, sessionDeleteQuestion } from './session-delete-question';

const issuance = (id: string, status: Session['status'] = 'completed') =>
  ({ id, status }) as Session;
const presentation = (id: string, status: Session['status'] = 'completed') =>
  ({ id, status, requestId: 'pid' }) as Session;

describe('sessionDeleteQuestion', () => {
  it('names the sessions, says what happens to issued credentials and that it is final', () => {
    const question = sessionDeleteQuestion([issuance('s-1'), issuance('s-2')]);

    expect(question).toMatch(/^Delete 2 sessions\?/);
    expect(question).toContain('• s-1\n• s-2');
    expect(question).toContain(DELETED_SESSION_CREDENTIALS);
    expect(question).toMatch(/This cannot be undone\.$/);
    expect(question).not.toContain('pending');
  });

  it('lists five sessions and counts the rest', () => {
    const sessions = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => issuance(id));

    const question = sessionDeleteQuestion(sessions);

    expect(question).toContain('• e\nand 2 more');
    expect(question).not.toContain('• f');
  });

  it('says how many sessions are still pending', () => {
    expect(sessionDeleteQuestion([issuance('s-1', 'active')])).toContain(
      'It is still pending: a wallet can no longer use its offer or request.'
    );
    expect(
      sessionDeleteQuestion([
        issuance('s-1', 'fetched'),
        issuance('s-2'),
        issuance('s-3', 'active'),
      ])
    ).toContain(
      '2 of them are still pending: a wallet can no longer use their offers or requests.'
    );
    expect(sessionDeleteQuestion([issuance('s-1', 'active'), issuance('s-2', 'active')])).toContain(
      'All of them are still pending'
    );
  });

  it('leaves out the credentials of presentation sessions, which issue none', () => {
    const question = sessionDeleteQuestion([presentation('p-1')]);

    expect(question).toMatch(/^Delete 1 session\?/);
    expect(question).not.toContain(DELETED_SESSION_CREDENTIALS);
  });
});
