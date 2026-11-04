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

  load(): DashboardSections {
    try {
      const raw = localStorage.getItem(this.storageKey(storagePrefix));
      const legacy = raw ? null : localStorage.getItem(this.storageKey(legacyStoragePrefix));
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

  save(sections: DashboardSections): void {
    try {
      localStorage.setItem(this.storageKey(storagePrefix), JSON.stringify(sections));
    } catch {
      // The dashboard remains usable when storage is blocked or unavailable.
    }
  }

  reset(): void {
    try {
      localStorage.removeItem(this.storageKey(storagePrefix));
      localStorage.removeItem(this.storageKey(legacyStoragePrefix));
    } catch {
      // The in-memory reset still applies when storage is unavailable.
    }
  }

  private storageKey(prefix: string): string {
    const caller = this.jwtService.getCaller();
    const tenant = caller?.tenantId || 'default';
    const user = caller?.subject || 'anonymous';
    return `${prefix}.${encodeURIComponent(tenant)}.${encodeURIComponent(user)}`;
  }
}
