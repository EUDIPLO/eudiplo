import { TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { provideRouter } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiService } from '../../../core';
import { SecretDialogComponent } from './secret-dialog.component';

function createDialog(clipboard?: { writeText: (text: string) => Promise<void> }) {
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
  const snackBar = { open: vi.fn() };
  TestBed.configureTestingModule({
    imports: [SecretDialogComponent],
    providers: [
      provideRouter([]),
      { provide: MAT_DIALOG_DATA, useValue: { clientId: 'client', secret: 's3cret', apiUrl: '' } },
      { provide: MatDialogRef, useValue: { close: vi.fn() } },
      { provide: MatSnackBar, useValue: snackBar },
      { provide: ApiService, useValue: {} },
    ],
  });
  return { dialog: TestBed.createComponent(SecretDialogComponent).componentInstance, snackBar };
}

describe('SecretDialogComponent', () => {
  afterEach(() => {
    delete (navigator as { clipboard?: Clipboard }).clipboard;
  });

  it('confirms a copied secret', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const { dialog, snackBar } = createDialog({ writeText });

    await dialog.copySecret();

    expect(writeText).toHaveBeenCalledWith('s3cret');
    expect(snackBar.open).toHaveBeenCalledWith('Secret copied to clipboard', 'Close', {
      duration: 2000,
    });
  });

  it('asks to copy by hand when the browser refuses to copy', async () => {
    const { dialog, snackBar } = createDialog({
      writeText: vi
        .fn()
        .mockRejectedValue(new DOMException('Write permission denied', 'NotAllowedError')),
    });

    await dialog.copyAll();

    expect(snackBar.open).toHaveBeenCalledWith(
      'Could not copy the secret. Select it and copy it by hand.',
      'Close',
      expect.anything()
    );
  });

  it('asks to copy by hand when the page has no clipboard access, as over plain HTTP', async () => {
    const { dialog, snackBar } = createDialog(undefined);

    await dialog.copySecret();

    expect(snackBar.open).toHaveBeenCalledWith(
      'Could not copy the secret. Select it and copy it by hand.',
      'Close',
      expect.anything()
    );
  });
});
