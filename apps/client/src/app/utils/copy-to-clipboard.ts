import type { MatSnackBar } from '@angular/material/snack-bar';

import { openErrorSnackBar } from './error-snackbar';

/**
 * Copies `text` and confirms it with `copied`. When the browser refuses, or the
 * page has no clipboard at all because it is served over plain HTTP, it opens
 * `failed` as an error instead.
 */
export async function copyToClipboard(
  snackBar: MatSnackBar,
  text: string,
  copied: string,
  failed = 'Failed to copy to clipboard'
): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    openErrorSnackBar(snackBar, failed);
    return;
  }
  snackBar.open(copied, 'Close', { duration: 2000 });
}
