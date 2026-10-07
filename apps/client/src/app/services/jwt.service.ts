import { Injectable } from '@angular/core';
import { RoleDto } from '@eudiplo/sdk-core';
import { ApiService } from '../core';

// Extend RoleDto to include registrar:manage which may not be in the SDK yet
export type Role =
  RoleDto['role'] | 'registrar:manage' | 'tenant:admin' | 'tenants:manage' | 'users:manage';

export const roles: Role[] = [
  'clients:manage',
  'issuance:manage',
  'issuance:offer',
  'presentation:manage',
  'presentation:request',
  'registrar:manage',
  'tenant:admin',
  'tenants:manage',
  'users:manage',
];

export function getRole(role: Role) {
  return role;
}

export interface JWTPayload {
  iss?: string;
  sub?: string;
  tenant_id?: string | null;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  azp?: string;
  scope?: string;
  realm_access?: {
    roles: string[];
  };
  resource_access?: Record<
    string,
    {
      roles: string[];
    }
  >;
  preferred_username?: string;
  email?: string;
  name?: string;
  roles: string[];
}

@Injectable({
  providedIn: 'root',
})
export class JwtService {
  constructor(private apiService: ApiService) {}

  /**
   * Decode a JWT token without verification
   * @param token JWT token string
   * @returns Decoded payload or null if invalid
   */
  decodeToken(token: string): JWTPayload | null {
    try {
      if (!token) return null;
      const parts = token.split('.');
      if (parts.length !== 3) {
        return null;
      }

      const payload = parts[1];
      const decoded = atob(payload.replaceAll('-', '+').replaceAll('_', '/'));
      return JSON.parse(decoded) as JWTPayload;
    } catch (error) {
      console.error('Error decoding JWT token:', error);
      return null;
    }
  }

  /**
   * Checks if a specific role is inside the jwt.
   * @param role
   * @returns
   */
  hasRole(role: Role | Role[]): boolean {
    const jwt = this.decodeToken(this.apiService.accessToken);
    if (!jwt) return false;

    const requiredRoles = Array.isArray(role) ? role : [role];
    if (jwt.roles) {
      return requiredRoles.some((requiredRole) => jwt.roles.includes(requiredRole));
    } else if (jwt.realm_access?.roles) {
      return requiredRoles.some((requiredRole) => jwt.realm_access!.roles.includes(requiredRole));
    }
    return false;
  }

  hasTenantContext(): boolean {
    return this.getTenantId() !== null;
  }

  /**
   * Tenant of the signed-in client from the token's `tenant_id` claim, or null without one.
   */
  getTenantId(): string | null {
    const jwt = this.decodeToken(this.apiService.accessToken);
    return typeof jwt?.tenant_id === 'string' && jwt.tenant_id.length > 0 ? jwt.tenant_id : null;
  }

  /**
   * Get all client roles for a specific client
   * @param token JWT token string
   * @param clientId Client ID to get roles for
   * @returns Array of client roles
   */
  getClientRoles(token: string, clientId: string): string[] {
    const payload = this.decodeToken(token);
    return payload?.resource_access?.[clientId]?.roles || [];
  }

  /**
   * Check if token is expired
   * @param token JWT token string
   * @returns True if token is expired
   */
  isTokenExpired(token: string): boolean {
    const payload = this.decodeToken(token);
    if (!payload?.exp) {
      return true;
    }
    return Date.now() >= payload.exp * 1000;
  }

  /**
   * Get user information from token
   * @param token JWT token string
   * @returns User information object
   */
  getUserInfo(token: string): { username?: string; email?: string; name?: string } | null {
    const payload = this.decodeToken(token);
    if (!payload) {
      return null;
    }

    return {
      username: payload.preferred_username,
      email: payload.email,
      name: payload.name,
    };
  }
}
