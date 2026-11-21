import type { Routes } from '@angular/router';
import { unsavedChangesGuard } from '../guards/unsaved-changes.guard';

export const keyManagementRoutes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./key-management-list/key-management-list.component').then(
        (m) => m.KeyManagementListComponent
      ),
  },
  {
    path: 'providers',
    redirectTo: '/kms',
    pathMatch: 'full',
  },
  {
    path: 'create',
    loadComponent: () =>
      import('./key-create-wizard/key-create-wizard.component').then(
        (m) => m.KeyCreateWizardComponent
      ),
    canDeactivate: [unsavedChangesGuard],
  },
  {
    path: ':id',
    loadComponent: () =>
      import('./key-management-show/key-management-show.component').then(
        (m) => m.KeyManagementShowComponent
      ),
  },
  {
    path: ':id/edit',
    loadComponent: () =>
      import('./key-management-create/key-management-create.component').then(
        (m) => m.KeyManagementCreateComponent
      ),
    canDeactivate: [unsavedChangesGuard],
  },
];
