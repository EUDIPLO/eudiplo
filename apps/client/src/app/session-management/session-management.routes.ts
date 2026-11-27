import type { Routes } from '@angular/router';
import { unsavedChangesGuard } from '../guards/unsaved-changes.guard';
import { RoleGuard } from '../guards/roles.guard';
import { SHARED_READ_ROLES } from '../services/resource-roles';
import { SESSION_READER_ROLES } from './session-roles';

export const sessionManagementRoutes: Routes = [
  {
    path: '',
    canActivate: [RoleGuard],
    data: { role: SESSION_READER_ROLES },
    loadComponent: () =>
      import('./session-management-list/session-management-list.component').then(
        (m) => m.SessionManagementListComponent
      ),
  },
  {
    path: 'config',
    canActivate: [RoleGuard],
    data: { role: SHARED_READ_ROLES },
    loadComponent: () =>
      import('../session-config/session-config.component').then((m) => m.SessionConfigComponent),
    canDeactivate: [unsavedChangesGuard],
  },
  {
    path: ':id',
    canActivate: [RoleGuard],
    data: { role: SESSION_READER_ROLES },
    loadComponent: () =>
      import('./session-management-show/session-management-show.component').then(
        (m) => m.SessionManagementShowComponent
      ),
  },
];
