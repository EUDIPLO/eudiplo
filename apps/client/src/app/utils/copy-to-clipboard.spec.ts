import type { MatSnackBar } from '@angular/material/snack-bar';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { copyToClipboard } from './copy-to-clipboard';

function setClipboard(clipboard: Pick<Clipboard, 'writeText'> | undefined): void {
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
}

describe('copyToClipboard', () => {
  afterEach(() => {
    delete (navigator as { clipboard?: Clipboard }).clipboard;
  });

  const snackBar = () => ({ open: vi.fn() });

  it('copies the text and confirms it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    const bar = snackBar();

    await copyToClipboard(bar as unknown as MatSnackBar, 's3cret', 'Secret copied to clipboard');

    expect(writeText).toHaveBeenCalledWith('s3cret');
    expect(bar.open).toHaveBeenCalledWith('Secret copied to clipboard', 'Close', {
      duration: 2000,
    });
  });

  it('opens the failure as an error when the browser refuses', async () => {
    setClipboard({
      writeText: vi
        .fn()
        .mockRejectedValue(new DOMException('Write permission denied', 'NotAllowedError')),
    });
    const bar = snackBar();

    await copyToClipboard(bar as unknown as MatSnackBar, 's3cret', 'Secret copied to clipboard');

    expect(bar.open).toHaveBeenCalledOnce();
    expect(bar.open).toHaveBeenCalledWith('Failed to copy to clipboard', 'Close', {
      duration: 5000,
    });
  });

  it('opens the given failure when the page has no clipboard, as over plain HTTP', async () => {
    setClipboard(undefined);
    const bar = snackBar();

    await copyToClipboard(
      bar as unknown as MatSnackBar,
      's3cret',
      'Secret copied to clipboard',
      'Could not copy the secret. Select it and copy it by hand.'
    );

    expect(bar.open).toHaveBeenCalledOnce();
    expect(bar.open).toHaveBeenCalledWith(
      'Could not copy the secret. Select it and copy it by hand.',
      'Close',
      expect.objectContaining({ duration: expect.any(Number) })
    );
  });
});
