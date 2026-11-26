import type { Routes } from '@angular/router';
import { unsavedChangesGuard } from '../guards/unsaved-changes.guard';
import { PRESENTATION_WRITE_ROLES, requireRole } from '../services/resource-roles';

export const oidcClientRoutes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./oidc-client-list/oidc-client-list.component').then(
        (m) => m.OidcClientListComponent
      ),
  },
  {
    path: 'create',
    ...requireRole(PRESENTATION_WRITE_ROLES),
    loadComponent: () =>
      import('./oidc-client-create/oidc-client-create.component').then(
        (m) => m.OidcClientCreateComponent
      ),
    canDeactivate: [unsavedChangesGuard],
  },
  {
    path: ':id',
    loadComponent: () =>
      import('./oidc-client-show/oidc-client-show.component').then(
        (m) => m.OidcClientShowComponent
      ),
  },
  {
    path: ':id/edit',
    ...requireRole(PRESENTATION_WRITE_ROLES),
    loadComponent: () =>
      import('./oidc-client-create/oidc-client-create.component').then(
        (m) => m.OidcClientCreateComponent
      ),
    canDeactivate: [unsavedChangesGuard],
  },
];
