import type { Routes } from '@angular/router';
import { unsavedChangesGuard } from './guards/unsaved-changes.guard';
import { AuthGuard } from './guards/auth.guard';
import { getRole, TENANT_ADMIN_ROLES } from './services/jwt.service';
import { RoleGuard } from './guards/roles.guard';

// Feature route imports
import {
  issuanceConfigRoutes,
  issuanceOfferRoutes,
  credentialConfigRoutes,
  attributeProviderRoutes,
} from './issuance/issuance.routes';
import { webhookEndpointRoutes } from './webhook-endpoint/webhook-endpoint.routes';
import { WEBHOOK_ENDPOINT_ROLES } from './webhook-endpoint/webhook-endpoint-roles';
import { oidcClientRoutes } from './oidc-client/oidc-client.routes';
import { keyManagementRoutes } from './key-management/key-management.routes';
import { KEY_CHAIN_ROLES } from './key-management/key-chain.service';
import {
  presentationConfigRoutes,
  presentationOfferRoutes,
} from './presentation/presentation.routes';
import { sessionManagementRoutes } from './session-management/session-management.routes';
import { statusListRoutes } from './status-list-management/status-list.routes';
import { clientRoutes, tenantRoutes } from './tenants/tenants.routes';
import { trustListRoutes } from './trust-list/trust-list.routes';
import { federationTrustAnchorRoutes } from './federation-trust-anchor/federation-trust-anchor.routes';
import { userRoutes } from './users/users.routes';

export const routes: Routes = [
  {
    path: 'login',
    loadComponent: () => import('./login/login.component').then((m) => m.LoginComponent),
  },
  {
    path: 'dashboard',
    loadComponent: () =>
      import('./dashboard/dashboard.component').then((m) => m.DashboardComponent),
    canActivate: [AuthGuard],
  },
  {
    path: 'settings/connection',
    loadComponent: () =>
      import('./settings/connection-settings/connection-settings.component').then(
        (m) => m.ConnectionSettingsComponent
      ),
    canActivate: [AuthGuard],
  },
  {
    path: 'settings/config-portability',
    loadComponent: () =>
      import('./config-portability/config-portability.component').then(
        (m) => m.ConfigPortabilityComponent
      ),
    canDeactivate: [unsavedChangesGuard],
    canActivate: [AuthGuard, RoleGuard],
    data: { role: TENANT_ADMIN_ROLES },
  },
  { path: '', redirectTo: '/dashboard', pathMatch: 'full' },
  // Pages of the removed sandbox registrar integration; old bookmarks land on the dashboard.
  { path: 'registrar', redirectTo: '/dashboard', pathMatch: 'full' },
  { path: 'schema', redirectTo: '/dashboard', pathMatch: 'prefix' },
  { path: 'schema-metadata', redirectTo: '/dashboard', pathMatch: 'prefix' },

  // Tenant & Client routes
  {
    path: 'clients',
    canActivate: [AuthGuard, RoleGuard],
    data: { role: getRole('clients:manage') },
    children: clientRoutes,
  },
  {
    path: 'users',
    canActivate: [AuthGuard, RoleGuard],
    data: { role: getRole('users:manage') },
    children: userRoutes,
  },
  {
    path: 'tenants',
    canActivate: [AuthGuard, RoleGuard],
    data: { role: getRole('tenants:manage') },
    children: tenantRoutes,
  },

  // Admin routes
  {
    path: 'admin/activity-logs',
    canActivate: [AuthGuard, RoleGuard],
    data: { role: [getRole('clients:manage'), getRole('audit:read')] },
    loadComponent: () =>
      import('./admin/admin-activity-logs/admin-activity-logs.component').then(
        (m) => m.AdminActivityLogsComponent
      ),
  },

  // Offer routes (issuance & presentation)
  {
    path: 'offer',
    canActivate: [AuthGuard],
    children: [
      {
        path: 'issuance',
        canActivate: [RoleGuard],
        data: { role: getRole('issuance:offer') },
        children: issuanceOfferRoutes,
      },
      {
        path: 'presentation',
        canActivate: [RoleGuard],
        data: { role: getRole('presentation:request') },
        children: presentationOfferRoutes,
      },
    ],
  },

  // Issuance routes
  {
    path: 'issuance-config',
    canActivate: [AuthGuard, RoleGuard],
    data: { role: getRole('issuance:manage') },
    children: issuanceConfigRoutes,
  },
  {
    path: 'credential-config',
    canActivate: [AuthGuard, RoleGuard],
    data: { role: getRole('issuance:manage') },
    children: credentialConfigRoutes,
  },
  {
    path: 'attribute-providers',
    canActivate: [AuthGuard, RoleGuard],
    data: { role: getRole('issuance:manage') },
    children: attributeProviderRoutes,
  },
  {
    path: 'webhook-endpoints',
    canActivate: [AuthGuard, RoleGuard],
    data: { role: WEBHOOK_ENDPOINT_ROLES },
    children: webhookEndpointRoutes,
  },

  // Key & Certificate routes
  {
    path: 'keys',
    canActivate: [AuthGuard, RoleGuard],
    data: { role: KEY_CHAIN_ROLES },
    children: keyManagementRoutes,
  },
  {
    path: 'kms',
    canActivate: [AuthGuard, RoleGuard],
    data: { role: KEY_CHAIN_ROLES },
    loadComponent: () =>
      import('./key-management/key-management-providers/key-management-providers.component').then(
        (m) => m.KeyManagementProvidersComponent
      ),
  },

  // Status list routes
  {
    path: 'status-lists',
    canActivate: [AuthGuard, RoleGuard],
    data: { role: getRole('issuance:manage') },
    children: statusListRoutes,
  },
  {
    path: 'status-list-config',
    canActivate: [AuthGuard, RoleGuard],
    data: { role: getRole('issuance:manage') },
    loadComponent: () =>
      import('./status-list-config/status-list-config.component').then(
        (m) => m.StatusListConfigComponent
      ),
    canDeactivate: [unsavedChangesGuard],
  },

  // Session management routes
  {
    path: 'session-management',
    canActivate: [AuthGuard],
    children: sessionManagementRoutes,
  },

  // Presentation config routes
  {
    path: 'presentation-config',
    canActivate: [AuthGuard, RoleGuard],
    data: { role: getRole('presentation:manage') },
    children: presentationConfigRoutes,
  },

  // OpenID Connect clients that sign users in with a wallet
  {
    path: 'oidc-clients',
    canActivate: [AuthGuard, RoleGuard],
    data: { role: getRole('presentation:manage') },
    children: oidcClientRoutes,
  },

  // Trust list routes: issuers publish trust lists, verifiers accept issuers from them
  {
    path: 'trust-list',
    canActivate: [AuthGuard, RoleGuard],
    data: { role: [getRole('issuance:manage'), getRole('presentation:manage')] },
    children: trustListRoutes,
  },

  // Federation trust anchors: issuance and presentation configurations trust them by entity ID
  {
    path: 'federation-trust-anchor',
    canActivate: [AuthGuard, RoleGuard],
    data: { role: [getRole('issuance:manage'), getRole('presentation:manage')] },
    children: federationTrustAnchorRoutes,
  },

  // Last: an address no route above matches, such as a mistyped one or a page of an older version.
  {
    path: '**',
    loadComponent: () => import('./common/not-found.component').then((m) => m.NotFoundComponent),
    canActivate: [AuthGuard],
  },
];
