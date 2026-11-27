import type { Routes } from '@angular/router';
import { unsavedChangesGuard } from '../guards/unsaved-changes.guard';
import { ISSUANCE_WRITE_ROLES, requireRole } from '../services/resource-roles';

export const statusListRoutes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./status-list-list/status-list-list.component').then(
        (m) => m.StatusListListComponent
      ),
  },
  {
    path: 'config',
    loadComponent: () =>
      import('../status-list-config/status-list-config.component').then(
        (m) => m.StatusListConfigComponent
      ),
    canDeactivate: [unsavedChangesGuard],
  },
  {
    path: 'create',
    ...requireRole(ISSUANCE_WRITE_ROLES),
    loadComponent: () =>
      import('./status-list-edit/status-list-edit.component').then(
        (m) => m.StatusListEditComponent
      ),
    canDeactivate: [unsavedChangesGuard],
  },
  {
    path: ':listId',
    loadComponent: () =>
      import('./status-list-edit/status-list-edit.component').then(
        (m) => m.StatusListEditComponent
      ),
    canDeactivate: [unsavedChangesGuard],
  },
];
