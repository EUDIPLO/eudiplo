import { Injectable } from '@angular/core';

import { JwtService } from '../services/jwt.service';

export type DashboardSection = 'activity' | 'recentActivity' | 'sessionOverview' | 'quickActions';
export type DashboardSections = Record<DashboardSection, boolean>;

/** Every section starts visible; a section the user's roles cannot fill stays hidden anyway. */
export const DEFAULT_DASHBOARD_SECTIONS: DashboardSections = {
  activity: true,
  recentActivity: true,
  sessionOverview: true,
  quickActions: true,
};

const storagePrefix = 'eudiplo.dashboard.sections.v2';
// v1 also stored focus presets; only its section choices carry over.
const legacyStoragePrefix = 'eudiplo.dashboard.preferences.v1';

@Injectable({ providedIn: 'root' })
export class DashboardPreferencesService {
  constructor(private readonly jwtService: JwtService) {}

  /** The sections the caller chose; the defaults before the caller is loaded. */
  load(): DashboardSections {
    const key = this.storageKey(storagePrefix);
    const legacyKey = this.storageKey(legacyStoragePrefix);
    if (!key || !legacyKey) return { ...DEFAULT_DASHBOARD_SECTIONS };
    try {
      const raw = localStorage.getItem(key);
      const legacy = raw ? null : localStorage.getItem(legacyKey);
      if (!raw && !legacy) return { ...DEFAULT_DASHBOARD_SECTIONS };

      const saved = (raw ? JSON.parse(raw) : JSON.parse(legacy!)?.visibleSections) as Partial<
        Record<DashboardSection, unknown>
      >;
      return Object.fromEntries(
        Object.entries(DEFAULT_DASHBOARD_SECTIONS).map(([section, visible]) => [
          section,
          typeof saved?.[section as DashboardSection] === 'boolean'
            ? saved[section as DashboardSection]
            : visible,
        ])
      ) as DashboardSections;
    } catch {
      return { ...DEFAULT_DASHBOARD_SECTIONS };
    }
  }

  /** Keeps the sections for the caller; without a loaded caller, they are not kept. */
  save(sections: DashboardSections): void {
    const key = this.storageKey(storagePrefix);
    if (!key) return;
    try {
      localStorage.setItem(key, JSON.stringify(sections));
    } catch {
      // The dashboard remains usable when storage is blocked or unavailable.
    }
  }

  reset(): void {
    const key = this.storageKey(storagePrefix);
    const legacyKey = this.storageKey(legacyStoragePrefix);
    if (!key || !legacyKey) return;
    try {
      localStorage.removeItem(key);
      localStorage.removeItem(legacyKey);
    } catch {
      // The in-memory reset still applies when storage is unavailable.
    }
  }

  /** Key of the caller's sections; none before the caller is loaded, so callers never share one. */
  private storageKey(prefix: string): string | undefined {
    const caller = this.jwtService.getCaller();
    if (!caller) return undefined;
    const tenant = caller.tenantId || 'default';
    const user = caller.subject || 'anonymous';
    return `${prefix}.${encodeURIComponent(tenant)}.${encodeURIComponent(user)}`;
  }
}
