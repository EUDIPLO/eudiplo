import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import type { CredentialStatusDto } from '@eudiplo/sdk-core';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionManagementService } from '../session-management.service';
import { CredentialStatusCardComponent } from './credential-status-card.component';

describe('CredentialStatusCardComponent', () => {
  let fixture: ComponentFixture<CredentialStatusCardComponent>;
  let sessions: {
    getCredentialStatus: ReturnType<typeof vi.fn>;
    updateCredentialStatus: ReturnType<typeof vi.fn>;
    formatDate: SessionManagementService['formatDate'];
  };
  let dialog: { open: ReturnType<typeof vi.fn> };
  let snackBar: { open: ReturnType<typeof vi.fn> };

  const valid: CredentialStatusDto = {
    credentialConfigurationId: 'pid',
    statusListId: 'list-1',
    index: 4,
    status: 0,
    bits: 1,
  };

  async function render(entries: CredentialStatusDto[], canChange = true): Promise<HTMLElement> {
    sessions.getCredentialStatus.mockResolvedValue(entries);
    fixture = TestBed.createComponent(CredentialStatusCardComponent);
    fixture.componentRef.setInput('sessionId', 'session-1');
    fixture.componentRef.setInput('canChange', canChange);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  function buttons(element: HTMLElement): string[] {
    return [...element.querySelectorAll('button')].map((button) => button.textContent!.trim());
  }

  beforeEach(async () => {
    sessions = {
      getCredentialStatus: vi.fn(),
      updateCredentialStatus: vi.fn().mockResolvedValue(undefined),
      formatDate: SessionManagementService.prototype.formatDate,
    };
    dialog = { open: vi.fn().mockReturnValue({ afterClosed: () => of(true) }) };
    snackBar = { open: vi.fn() };
    await TestBed.configureTestingModule({
      imports: [CredentialStatusCardComponent],
      providers: [
        { provide: SessionManagementService, useValue: sessions },
        { provide: MatDialog, useValue: dialog },
        { provide: MatSnackBar, useValue: snackBar },
      ],
    }).compileComponents();
  });

  it('renders nothing for a session without credential status', async () => {
    const element = await render([]);

    expect(sessions.getCredentialStatus).toHaveBeenCalledWith('session-1');
    expect(element.querySelector('mat-card')).toBeNull();
  });

  it('shows the status and only the changes the list allows', async () => {
    const element = await render([valid]);

    expect(element.textContent).toContain('1 valid');
    expect(buttons(element).map((text) => text.replace(/^\w+\s+/, ''))).toEqual(['Revoke']);
  });

  it('shows when the status of a configuration last changed', async () => {
    const changedAt = '2026-10-25T14:03:00.000Z';
    const element = await render([{ ...valid, status: 1, statusUpdatedAt: changedAt }]);
    const shown = new Date(changedAt).toLocaleString();

    expect(element.querySelector('.last-changed')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      `Last change: list-1 #4 revoked, ${shown}`
    );
    expect(fixture.componentInstance.entryTooltip(fixture.componentInstance.groups[0])).toBe(
      `list-1 #4: revoked (changed ${shown})`
    );
  });

  it('shows no change time for a status that never changed', async () => {
    const element = await render([valid]);

    expect(element.querySelector('.last-changed')).toBeNull();
    expect(fixture.componentInstance.entryTooltip(fixture.componentInstance.groups[0])).toBe(
      'list-1 #4: valid'
    );
  });

  it('shows the status without changes to a caller that may only read it', async () => {
    const element = await render([valid], false);

    expect(element.textContent).toContain('1 valid');
    expect(buttons(element)).toEqual([]);
    expect(element.textContent).toContain('needs the credentials:status or issuance:manage role');
  });

  it('revokes the credentials of a configuration after confirmation and reads the status again', async () => {
    await render([valid]);
    sessions.getCredentialStatus.mockResolvedValue([{ ...valid, status: 1 }]);

    const component = fixture.componentInstance;
    component.change(component.groups[0], 1);
    await vi.waitFor(() => expect(sessions.getCredentialStatus).toHaveBeenCalledTimes(2));

    expect(dialog.open.mock.lastCall?.[1].data).toEqual({
      status: 1,
      credentialConfigurationId: 'pid',
      count: 1,
    });
    expect(sessions.updateCredentialStatus).toHaveBeenCalledWith('session-1', 1, 'pid');
    await vi.waitFor(() => expect(component.groups[0].canRevoke).toBe(false));
  });

  it('changes nothing when the dialog is dismissed', async () => {
    await render([valid]);
    dialog.open.mockReturnValue({ afterClosed: () => of(false) });

    fixture.componentInstance.change(fixture.componentInstance.groups[0], 1);

    expect(sessions.updateCredentialStatus).not.toHaveBeenCalled();
  });

  it('shows why a change was rejected', async () => {
    await render([valid]);
    sessions.updateCredentialStatus.mockRejectedValue({
      statusCode: 409,
      message: 'A revoked credential cannot be reinstated: revocation is final.',
    });

    fixture.componentInstance.change(fixture.componentInstance.groups[0], 0);
    await vi.waitFor(() => expect(snackBar.open).toHaveBeenCalled());

    expect(snackBar.open.mock.lastCall?.[0]).toContain('revocation is final');
  });
});
