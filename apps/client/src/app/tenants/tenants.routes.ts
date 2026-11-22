import type { Routes } from '@angular/router';
import { unsavedChangesGuard } from '../guards/unsaved-changes.guard';

export const tenantRoutes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./tenant-list/tenant-list.component').then((m) => m.TenantListComponent),
  },
  {
    path: 'create',
    loadComponent: () =>
      import('./tenant-create/tenant-create.component').then((m) => m.TenantCreateComponent),
    canDeactivate: [unsavedChangesGuard],
  },
  {
    path: ':id',
    loadComponent: () =>
      import('./tenant-show/tenant-show.component').then((m) => m.TenantShowComponent),
  },
  {
    path: ':id/edit',
    loadComponent: () =>
      import('./tenant-create/tenant-create.component').then((m) => m.TenantCreateComponent),
    canDeactivate: [unsavedChangesGuard],
  },
];

export const clientRoutes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./client/client-list/client-list.component').then((m) => m.ClientListComponent),
  },
  {
    path: 'create',
    loadComponent: () =>
      import('./client/client-create/client-create.component').then((m) => m.ClientCreateComponent),
    canDeactivate: [unsavedChangesGuard],
  },
  {
    path: ':id',
    loadComponent: () =>
      import('./client/client-show/client-show.component').then((m) => m.ClientShowComponent),
  },
  {
    path: ':id/edit',
    loadComponent: () =>
      import('./client/client-create/client-create.component').then((m) => m.ClientCreateComponent),
    canDeactivate: [unsavedChangesGuard],
  },
];
