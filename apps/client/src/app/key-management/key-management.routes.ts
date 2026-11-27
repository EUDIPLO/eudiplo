import type { Routes } from '@angular/router';
import { unsavedChangesGuard } from '../guards/unsaved-changes.guard';
import { requireRole } from '../services/resource-roles';
import { KEY_ADMIN_ROLE } from './key-chain.service';

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
    ...requireRole(KEY_ADMIN_ROLE),
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
    ...requireRole(KEY_ADMIN_ROLE),
    loadComponent: () =>
      import('./key-management-create/key-management-create.component').then(
        (m) => m.KeyManagementCreateComponent
      ),
    canDeactivate: [unsavedChangesGuard],
  },
];
