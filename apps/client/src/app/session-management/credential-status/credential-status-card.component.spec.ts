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

  async function render(entries: CredentialStatusDto[]): Promise<HTMLElement> {
    sessions.getCredentialStatus.mockResolvedValue(entries);
    fixture = TestBed.createComponent(CredentialStatusCardComponent);
    fixture.componentRef.setInput('sessionId', 'session-1');
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
