import type { Routes } from '@angular/router';

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
    loadComponent: () =>
      import('./oidc-client-create/oidc-client-create.component').then(
        (m) => m.OidcClientCreateComponent
      ),
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
    loadComponent: () =>
      import('./oidc-client-create/oidc-client-create.component').then(
        (m) => m.OidcClientCreateComponent
      ),
  },
];
