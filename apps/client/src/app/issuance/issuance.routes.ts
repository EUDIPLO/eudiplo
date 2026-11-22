import type { Routes } from '@angular/router';
import { unsavedChangesGuard } from '../guards/unsaved-changes.guard';

export const issuanceOfferRoutes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./issuance-offer/issuance-offer.component').then((m) => m.IssuanceOfferComponent),
  },
  {
    path: ':id',
    loadComponent: () =>
      import('./issuance-offer/issuance-offer.component').then((m) => m.IssuanceOfferComponent),
  },
];

export const issuanceConfigRoutes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./issuance-config/issuance-config-show/issuance-config-show.component').then(
        (m) => m.IssuanceConfigShowComponent
      ),
  },
  {
    path: 'edit',
    loadComponent: () =>
      import('./issuance-config/issuance-config-create/issuance-config-create.component').then(
        (m) => m.IssuanceConfigCreateComponent
      ),
    canDeactivate: [unsavedChangesGuard],
  },
];

export const credentialConfigRoutes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./credential-config/credential-config-list/credential-config-list.component').then(
        (m) => m.CredentialConfigListComponent
      ),
  },
  {
    path: 'create',
    loadComponent: () =>
      import('./credential-config/credential-config-create/credential-config-create.component').then(
        (m) => m.CredentialConfigCreateComponent
      ),
    canDeactivate: [unsavedChangesGuard],
  },
  {
    path: ':id',
    loadComponent: () =>
      import('./credential-config/credential-config-show/credential-config-show.component').then(
        (m) => m.CredentialConfigShowComponent
      ),
  },
  {
    path: ':id/edit',
    loadComponent: () =>
      import('./credential-config/credential-config-create/credential-config-create.component').then(
        (m) => m.CredentialConfigCreateComponent
      ),
    canDeactivate: [unsavedChangesGuard],
  },
];

export const attributeProviderRoutes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./attribute-provider/attribute-provider-list/attribute-provider-list.component').then(
        (m) => m.AttributeProviderListComponent
      ),
  },
  {
    path: 'create',
    loadComponent: () =>
      import('./attribute-provider/attribute-provider-create/attribute-provider-create.component').then(
        (m) => m.AttributeProviderCreateComponent
      ),
    canDeactivate: [unsavedChangesGuard],
  },
  {
    path: ':id',
    loadComponent: () =>
      import('./attribute-provider/attribute-provider-show/attribute-provider-show.component').then(
        (m) => m.AttributeProviderShowComponent
      ),
  },
  {
    path: ':id/edit',
    loadComponent: () =>
      import('./attribute-provider/attribute-provider-create/attribute-provider-create.component').then(
        (m) => m.AttributeProviderCreateComponent
      ),
    canDeactivate: [unsavedChangesGuard],
  },
];
