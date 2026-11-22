import type { Routes } from '@angular/router';
import { unsavedChangesGuard } from '../guards/unsaved-changes.guard';

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
    loadComponent: () =>
      import('./federation-trust-anchor-edit/federation-trust-anchor-edit.component').then(
        (m) => m.FederationTrustAnchorEditComponent
      ),
    canDeactivate: [unsavedChangesGuard],
  },
];
