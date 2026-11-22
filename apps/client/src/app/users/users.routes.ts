import type { Routes } from '@angular/router';
import { unsavedChangesGuard } from '../guards/unsaved-changes.guard';

export const userRoutes: Routes = [
  {
    path: '',
    loadComponent: () => import('./user-list/user-list.component').then((m) => m.UserListComponent),
  },
  {
    path: 'create',
    loadComponent: () =>
      import('./user-create/user-create.component').then((m) => m.UserCreateComponent),
    canDeactivate: [unsavedChangesGuard],
  },
  {
    path: ':id',
    loadComponent: () => import('./user-show/user-show.component').then((m) => m.UserShowComponent),
  },
  {
    path: ':id/edit',
    loadComponent: () =>
      import('./user-create/user-create.component').then((m) => m.UserCreateComponent),
    canDeactivate: [unsavedChangesGuard],
  },
];
