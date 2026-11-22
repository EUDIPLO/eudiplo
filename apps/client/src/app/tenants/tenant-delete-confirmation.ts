import type { MatSnackBar } from '@angular/material/snack-bar';

import { openErrorSnackBar } from '../utils/error-snackbar';

/** What the list and the tenant page need of a tenant to ask before deleting it. */
export interface TenantToDelete {
  id: string;
  name?: string;
}

/**
 * Question before a tenant is deleted, on its list and on its page. Names are not unique and
 * may differ from the ID, so it names the ID and asks for it to be typed. The backend deletes
 * everything that belongs to the tenant in one request.
 */
export function tenantDeleteQuestion(tenant: TenantToDelete): string {
  const name =
    tenant.name && tenant.name !== tenant.id ? `"${tenant.name}" (${tenant.id})` : `"${tenant.id}"`;
  return [
    `Delete tenant ${name} and all its data?`,
    'Its key chains, configurations, API clients, sessions, status lists and trust lists are deleted, and verifiers can no longer fetch the status lists of credentials it issued. This cannot be undone.',
    `Type the tenant ID "${tenant.id}" to confirm.`,
  ].join('\n\n');
}

/**
 * Asks for the tenant ID before a delete. Returns whether the user typed it; says so when the
 * typed text is another one, and nothing when the user cancelled.
 */
export function confirmTenantDelete(snackBar: MatSnackBar, tenant: TenantToDelete): boolean {
  const typed = prompt(tenantDeleteQuestion(tenant));
  if (typed === null) return false;
  if (typed.trim() !== tenant.id) {
    openErrorSnackBar(
      snackBar,
      `The ID you typed is not "${tenant.id}". The tenant was not deleted.`
    );
    return false;
  }
  return true;
}
