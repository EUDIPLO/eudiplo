import type { Routes } from '@angular/router';
import { unsavedChangesGuard } from '../guards/unsaved-changes.guard';

export const webhookEndpointRoutes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./webhook-endpoint-list/webhook-endpoint-list.component').then(
        (m) => m.WebhookEndpointListComponent
      ),
  },
  {
    path: 'create',
    loadComponent: () =>
      import('./webhook-endpoint-create/webhook-endpoint-create.component').then(
        (m) => m.WebhookEndpointCreateComponent
      ),
    canDeactivate: [unsavedChangesGuard],
  },
  {
    path: ':id',
    loadComponent: () =>
      import('./webhook-endpoint-show/webhook-endpoint-show.component').then(
        (m) => m.WebhookEndpointShowComponent
      ),
  },
  {
    path: ':id/edit',
    loadComponent: () =>
      import('./webhook-endpoint-create/webhook-endpoint-create.component').then(
        (m) => m.WebhookEndpointCreateComponent
      ),
    canDeactivate: [unsavedChangesGuard],
  },
];
