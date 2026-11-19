import { TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OidcClientSecretDialogComponent } from './oidc-client-secret-dialog.component';

describe('OidcClientSecretDialogComponent', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  function render() {
    TestBed.configureTestingModule({
      imports: [OidcClientSecretDialogComponent],
      providers: [
        {
          provide: MAT_DIALOG_DATA,
          useValue: {
            clientId: 'c7d1',
            clientSecret: 's3cret',
            issuer: 'https://eudiplo.example/verifiers/root/oidc',
          },
        },
        { provide: MatDialogRef, useValue: { close: vi.fn() } },
        { provide: MatSnackBar, useValue: { open: vi.fn() } },
      ],
    });
    const fixture = TestBed.createComponent(OidcClientSecretDialogComponent);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('shows the issuer, client ID and secret, each with a copy button', () => {
    const page = render();

    expect([...page.querySelectorAll('.credential .label')].map((l) => l.textContent)).toEqual([
      'Issuer',
      'Client ID',
      'Client secret',
    ]);
    expect(page.querySelector('.value.secret')?.textContent).toBe('s3cret');
    expect(
      [...page.querySelectorAll('.credential button')].map((b) => b.getAttribute('aria-label'))
    ).toEqual(['Copy issuer', 'Copy client ID', 'Copy client secret']);
    expect(page.querySelector('[role="note"]')?.textContent).toContain('shown only once');
  });

  it('copies the secret to the clipboard', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const page = render();

    page.querySelectorAll<HTMLButtonElement>('.credential button')[2].click();

    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('s3cret'));
  });
});
