import type { Routes } from '@angular/router';
import { unsavedChangesGuard } from '../guards/unsaved-changes.guard';
import { PRESENTATION_WRITE_ROLES, requireRole } from '../services/resource-roles';
import { RoleGuard } from '../guards/roles.guard';

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
    ...requireRole(PRESENTATION_WRITE_ROLES),
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
    ...requireRole(PRESENTATION_WRITE_ROLES),
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
    canActivate: [RoleGuard],
    data: { role: PRESENTATION_WRITE_ROLES, copy: true },
    canDeactivate: [unsavedChangesGuard],
  },
];
