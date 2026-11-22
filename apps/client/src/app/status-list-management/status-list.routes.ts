import type { Routes } from '@angular/router';
import { unsavedChangesGuard } from '../guards/unsaved-changes.guard';

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
