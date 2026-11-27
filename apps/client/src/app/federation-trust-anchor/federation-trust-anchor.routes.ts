import type { Routes } from '@angular/router';
import { unsavedChangesGuard } from '../guards/unsaved-changes.guard';
import { requireRole, SHARED_WRITE_ROLES } from '../services/resource-roles';

export const federationTrustAnchorRoutes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./federation-trust-anchor-list/federation-trust-anchor-list.component').then(
        (m) => m.FederationTrustAnchorListComponent
      ),
  },
  {
    path: 'create',
    ...requireRole(SHARED_WRITE_ROLES),
    loadComponent: () =>
      import('./federation-trust-anchor-edit/federation-trust-anchor-edit.component').then(
        (m) => m.FederationTrustAnchorEditComponent
      ),
    canDeactivate: [unsavedChangesGuard],
  },
  {
    path: ':id',
    loadComponent: () =>
      import('./federation-trust-anchor-show/federation-trust-anchor-show.component').then(
        (m) => m.FederationTrustAnchorShowComponent
      ),
  },
  {
    path: ':id/edit',
    ...requireRole(SHARED_WRITE_ROLES),
    loadComponent: () =>
      import('./federation-trust-anchor-edit/federation-trust-anchor-edit.component').then(
        (m) => m.FederationTrustAnchorEditComponent
      ),
    canDeactivate: [unsavedChangesGuard],
  },
];
