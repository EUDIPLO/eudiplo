import type { Routes } from '@angular/router';
import { unsavedChangesGuard } from '../guards/unsaved-changes.guard';

export const trustListRoutes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./trust-list-list/trust-list-list.component').then((m) => m.TrustListListComponent),
  },
  {
    path: 'create',
    loadComponent: () =>
      import('./trust-list-edit/trust-list-edit.component').then((m) => m.TrustListEditComponent),
    canDeactivate: [unsavedChangesGuard],
  },
  {
    path: ':id',
    loadComponent: () =>
      import('./trust-list-show/trust-list-show.component').then((m) => m.TrustListShowComponent),
  },
  {
    path: ':id/edit',
    loadComponent: () =>
      import('./trust-list-edit/trust-list-edit.component').then((m) => m.TrustListEditComponent),
    canDeactivate: [unsavedChangesGuard],
  },
];
