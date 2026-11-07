import { JwtService, type Caller } from '../services/jwt.service';
import {
  DEFAULT_DASHBOARD_SECTIONS,
  DashboardPreferencesService,
  type DashboardSections,
} from './dashboard-preferences.service';

describe('DashboardPreferencesService', () => {
  let caller: Caller | undefined;
  let service: DashboardPreferencesService;

  beforeEach(() => {
    const entries = new Map<string, string>();
    const storage = {
      get length() {
        return entries.size;
      },
      clear: () => entries.clear(),
      getItem: (key: string) => entries.get(key) ?? null,
      key: (index: number) => [...entries.keys()][index] ?? null,
      removeItem: (key: string) => entries.delete(key),
      setItem: (key: string, value: string) => entries.set(key, value),
    } as Storage;
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
    localStorage.clear();
    caller = { subject: 'user-a', tenantId: 'tenant-a', roles: [] };
    const jwtService = { getCaller: () => caller } as unknown as JwtService;
    service = new DashboardPreferencesService(jwtService);
  });

  it('shows every section when nothing is saved', () => {
    expect(service.load()).toEqual(DEFAULT_DASHBOARD_SECTIONS);
  });

  it('persists the visible sections for the current user', () => {
    const sections: DashboardSections = {
      activity: true,
      recentActivity: false,
      sessionOverview: true,
      quickActions: false,
    };

    service.save(sections);

    expect(service.load()).toEqual(sections);
  });

  it('keeps sections separate between users', () => {
    service.save({ ...DEFAULT_DASHBOARD_SECTIONS, activity: false });
    caller = { subject: 'user-b', tenantId: 'tenant-a', roles: [] };

    expect(service.load()).toEqual(DEFAULT_DASHBOARD_SECTIONS);
  });

  it('falls back to the defaults for malformed or partial entries', () => {
    localStorage.setItem('eudiplo.dashboard.sections.v2.tenant-a.user-a', '{broken');
    expect(service.load()).toEqual(DEFAULT_DASHBOARD_SECTIONS);

    localStorage.setItem(
      'eudiplo.dashboard.sections.v2.tenant-a.user-a',
      JSON.stringify({ activity: false, quickActions: 'no' })
    );
    expect(service.load()).toEqual({ ...DEFAULT_DASHBOARD_SECTIONS, activity: false });
  });

  it('keeps the sections a user hid before focus presets were removed', () => {
    localStorage.setItem(
      'eudiplo.dashboard.preferences.v1.tenant-a.user-a',
      JSON.stringify({
        focus: 'operations',
        visibleSections: { recentActivity: false, quickActions: false, resources: true },
      })
    );

    expect(service.load()).toEqual({
      ...DEFAULT_DASHBOARD_SECTIONS,
      recentActivity: false,
      quickActions: false,
    });
    service.reset();
    expect(service.load()).toEqual(DEFAULT_DASHBOARD_SECTIONS);
  });

  it('keeps nothing before the caller is loaded, so callers never share one entry', () => {
    caller = undefined;
    service.save({ ...DEFAULT_DASHBOARD_SECTIONS, activity: false });

    expect(localStorage.length).toBe(0);
    expect(service.load()).toEqual(DEFAULT_DASHBOARD_SECTIONS);
  });
});
