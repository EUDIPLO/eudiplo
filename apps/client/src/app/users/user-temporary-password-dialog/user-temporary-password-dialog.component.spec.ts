import { TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { UserTemporaryPasswordDialogComponent } from './user-temporary-password-dialog.component';

function createDialog(clipboard?: { writeText: (text: string) => Promise<void> }) {
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
  const snackBar = { open: vi.fn() };
  TestBed.configureTestingModule({
    imports: [UserTemporaryPasswordDialogComponent],
    providers: [
      { provide: MAT_DIALOG_DATA, useValue: { username: 'alice', temporaryPassword: 'tmp-pw' } },
      { provide: MatDialogRef, useValue: { close: vi.fn() } },
      { provide: MatSnackBar, useValue: snackBar },
    ],
  });
  return {
    dialog: TestBed.createComponent(UserTemporaryPasswordDialogComponent).componentInstance,
    snackBar,
  };
}

describe('UserTemporaryPasswordDialogComponent', () => {
  afterEach(() => {
    delete (navigator as { clipboard?: Clipboard }).clipboard;
  });

  it('confirms copied login details', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const { dialog, snackBar } = createDialog({ writeText });

    await dialog.copyAll();

    expect(writeText).toHaveBeenCalledWith('Username: alice\nTemporary Password: tmp-pw');
    expect(snackBar.open).toHaveBeenCalledWith('Login details copied to clipboard', 'Close', {
      duration: 2000,
    });
  });

  it('asks to copy by hand when the password cannot be copied', async () => {
    const { dialog, snackBar } = createDialog({
      writeText: vi
        .fn()
        .mockRejectedValue(new DOMException('Write permission denied', 'NotAllowedError')),
    });

    await dialog.copyPassword();

    expect(snackBar.open).toHaveBeenCalledWith(
      'Could not copy the password. Select it and copy it by hand.',
      'Close',
      expect.anything()
    );
  });
});
