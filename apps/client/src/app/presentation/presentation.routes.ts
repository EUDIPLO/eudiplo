import type { Routes } from '@angular/router';
import { unsavedChangesGuard } from '../guards/unsaved-changes.guard';

export const presentationOfferRoutes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./presentation-request/presentation-request.component').then(
        (m) => m.PresentationRequestComponent
      ),
  },
  {
    path: ':id',
    loadComponent: () =>
      import('./presentation-request/presentation-request.component').then(
        (m) => m.PresentationRequestComponent
      ),
  },
];

export const presentationConfigRoutes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./presentation-config/presentation-list/presentation-list.component').then(
        (m) => m.PresentationListComponent
      ),
  },
  {
    path: 'create',
    loadComponent: () =>
      import('./presentation-config/presentation-create/presentation-create.component').then(
        (m) => m.PresentationCreateComponent
      ),
    canDeactivate: [unsavedChangesGuard],
  },
  {
    path: ':id',
    loadComponent: () =>
      import('./presentation-config/presentation-show/presentation-show.component').then(
        (m) => m.PresentationShowComponent
      ),
  },
  {
    path: ':id/edit',
    loadComponent: () =>
      import('./presentation-config/presentation-create/presentation-create.component').then(
        (m) => m.PresentationCreateComponent
      ),
    canDeactivate: [unsavedChangesGuard],
  },
  {
    path: ':id/copy',
    loadComponent: () =>
      import('./presentation-config/presentation-create/presentation-create.component').then(
        (m) => m.PresentationCreateComponent
      ),
    canDeactivate: [unsavedChangesGuard],
  },
];
