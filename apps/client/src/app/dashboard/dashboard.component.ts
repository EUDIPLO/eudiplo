import { Component, type OnInit, ChangeDetectionStrategy } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DatePipe, PercentPipe } from '@angular/common';
import type { Session } from '@eudiplo/sdk-core';

import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { type Params, RouterModule } from '@angular/router';
import { FlexLayoutModule } from 'ngx-flexible-layout';
import { JwtService } from '../services/jwt.service';
import { GrafanaLinkService } from '../services/grafana-link.service';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { DashboardService, DashboardSource } from './dashboard.service';
import { isPresentationSession } from '../session-management/session-management.service';
import { toDay } from '../utils/local-day';
import { ActivityChartComponent } from './activity-chart/activity-chart.component';
import {
  DashboardPreferencesService,
  DashboardSection,
  DashboardSections,
} from './dashboard-preferences.service';

interface StatCard {
  source: DashboardSource;
  value: string;
  label: string;
  /** Context below the label, for example the comparison value. */
  note?: string;
  /** Explains how the value is computed. */
  hint?: string;
  icon: string;
  iconClass: string;
  route: string;
  queryParams?: Params;
}

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [
    FlexLayoutModule,
    MatCardModule,
    MatButtonModule,
    MatDividerModule,
    MatIconModule,
    MatChipsModule,
    MatProgressBarModule,
    MatProgressSpinnerModule,
    MatSnackBarModule,
    MatTooltipModule,
    MatCheckboxModule,
    DatePipe,
    RouterModule,
    ActivityChartComponent,
  ],
  templateUrl: './dashboard.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: ['./dashboard.component.scss'],
})
export class DashboardComponent implements OnInit {
  grafanaEnabled = false;
  customizePanelOpen = false;
  sections: DashboardSections;
  private readonly percent = new PercentPipe('en-US');

  constructor(
    public dashboardService: DashboardService,
    public grafanaLinkService: GrafanaLinkService,
    public jwtService: JwtService,
    private readonly snackBar: MatSnackBar,
    private readonly dashboardPreferencesService: DashboardPreferencesService
  ) {
    this.sections = this.dashboardPreferencesService.load();
    // The page may open before the caller's roles are loaded, for example
    // when loading them failed; once they are, its data and sections follow them.
    this.jwtService.callerChanged$.pipe(takeUntilDestroyed()).subscribe(() => {
      this.sections = this.dashboardPreferencesService.load();
      void this.dashboardService.getCounters();
    });
  }

  ngOnInit(): void {
    // Fetch dashboard stats
    this.dashboardService.getCounters();

    // Load Grafana config
    this.grafanaLinkService.getConfig().then(() => {
      this.grafanaEnabled = this.grafanaLinkService.isEnabled();
    });
  }

  refresh(): void {
    // Failures end up in the service's warnings.
    void this.dashboardService.getCounters({ keepPrevious: true });
  }

  /** Session KPIs for users who can read sessions, configuration counts for the others. */
  get statCards(): StatCard[] {
    return this.dashboardService.canViewSessions ? this.kpiCards : this.configCards;
  }

  private get kpiCards(): StatCard[] {
    const service = this.dashboardService;
    const activity = service.activity;
    const label = activity?.label ?? '…';
    // The session list filters by day; the window's first day covers the window.
    const since = activity ? { createdFrom: toDay(activity.starts[0]) } : {};
    const current = activity?.unit === 'hour' ? 'this hour' : 'today';
    const buckets = service.isLoaded('activity') ? service.activityBuckets : [];
    const rate = service.successRate;
    return [
      {
        source: 'window',
        value: String(service.sessionsInWindow),
        label: `Sessions · ${label}`,
        note: buckets.length ? `${service.sessionsInCurrentBucket} ${current}` : undefined,
        icon: 'today',
        iconClass: 'sessions',
        route: '/session-management',
        queryParams: since,
      },
      {
        source: 'window',
        value: rate === null ? '–' : (this.percent.transform(rate) ?? '–'),
        label: `Success rate · ${label}`,
        note: `of ${service.finishedInWindow} finished`,
        hint: 'Completed share of the sessions that completed, failed or expired',
        icon: 'task_alt',
        iconClass: 'success',
        route: '/session-management',
        queryParams: { ...since, status: ['completed', 'failed', 'expired'] },
      },
      {
        source: 'window',
        value: String(service.failedInWindow),
        label: `Failed · ${label}`,
        note: buckets.length ? `${buckets.at(-1)?.failed ?? 0} ${current}` : undefined,
        icon: 'error',
        // Red only when something failed
        iconClass: service.failedInWindow > 0 ? 'failed' : 'muted',
        route: '/session-management',
        queryParams: { ...since, status: 'failed' },
      },
      {
        source: 'sessionStats',
        value: String(service.pendingSessions),
        label: 'Pending sessions',
        note: 'waiting for a wallet',
        icon: 'hourglass_empty',
        iconClass: 'open',
        route: '/session-management',
        queryParams: { status: ['active', 'fetched'] },
      },
    ];
  }

  private get configCards(): StatCard[] {
    const service = this.dashboardService;
    const cards: StatCard[] = [];
    if (service.canManageIssuance) {
      cards.push({
        source: 'credentials',
        value: String(service.credentialConfigs),
        label: 'Credential Configs',
        icon: 'badge',
        iconClass: 'credential',
        route: '/credential-config',
      });
    }
    if (service.canManagePresentation) {
      cards.push({
        source: 'presentations',
        value: String(service.presentationConfigs),
        label: 'Presentation Configs',
        icon: 'verified_user',
        iconClass: 'presentation',
        route: '/presentation-config',
      });
    }
    if (service.canManageKeyChains) {
      cards.push({
        source: 'keyChains',
        value: String(service.totalKeyChains),
        label: 'Key Chains',
        icon: 'vpn_key',
        iconClass: 'keys',
        route: '/keys',
      });
    }
    return cards;
  }

  /** Session list filter for the failed sessions of the activity window. */
  get failedParams(): Params {
    const start = this.dashboardService.activity?.starts[0];
    return { status: 'failed', ...(start ? { createdFrom: toDay(start) } : {}) };
  }

  /** Session list filter for a failure code of the activity window. */
  failureCodeParams(code: string): Params {
    return { ...this.failedParams, failureCode: code };
  }

  /** Why the window is shorter than a week, or null when it is not. */
  get retentionNote(): string | null {
    const retention = this.dashboardService.sessionStats.retention;
    const activity = this.dashboardService.activity;
    if (!retention || !activity?.limitedByRetention) return null;
    return `Only the last ${activity.label}: sessions are deleted ${formatDuration(retention.ttlSeconds)} after creation.`;
  }

  get kmsSummary(): string {
    const unhealthy = this.dashboardService.unhealthyKmsProviders.length;
    if (unhealthy === 0) return 'All providers reachable';
    return `${unhealthy} of ${this.dashboardService.kmsProviders.length} unreachable`;
  }

  /** The value once its request has loaded, otherwise what the user is waiting for. */
  loadedValue(source: DashboardSource, value: string): string {
    if (this.dashboardService.isLoaded(source)) return value;
    return this.dashboardService.hasFailed(source) ? 'Could not be loaded' : 'Loading…';
  }

  sessionTypeLabel(session: Session): string {
    return isPresentationSession(session) ? 'Presentation' : 'Issuance';
  }

  sessionDetails(session: Session): string {
    return [session.requestId, session.reference, session.failureCode, session.id.slice(0, 8)]
      .filter((part) => !!part)
      .join(' · ');
  }

  openGrafana(): void {
    const url = this.grafanaLinkService.getBaseUrl();
    if (url) {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }

  /** Whether the caller's roles could not be loaded, so the page has nothing to show for them. */
  get rolesMissing(): boolean {
    return this.jwtService.getCaller() === undefined;
  }

  /** Loads the caller's roles again; the page loads its figures once they are there. */
  retryRoles(): void {
    void this.jwtService.loadCaller({ reload: true });
  }

  get readinessTitle(): string {
    if (this.rolesMissing) return 'Your roles could not be loaded';
    if (this.dashboardService.isLoading) return 'Checking system readiness…';
    if (this.dashboardService.hasWarnings) {
      const count = this.dashboardService.warnings.length;
      return `${count} ${count === 1 ? 'item needs' : 'items need'} attention`;
    }
    if (this.dashboardService.isReadOnly) {
      return 'Monitoring access: your roles cannot change the issuance or presentation setup';
    }
    if (this.dashboardService.isSetupComplete) return 'Ready for wallet flows';
    return 'Setup incomplete';
  }

  isSectionVisible(section: DashboardSection): boolean {
    return this.sections[section];
  }

  setSectionVisibility(section: DashboardSection, visible: boolean): void {
    this.sections = { ...this.sections, [section]: visible };
    this.dashboardPreferencesService.save(this.sections);
  }

  resetDashboard(): void {
    this.dashboardPreferencesService.reset();
    this.sections = this.dashboardPreferencesService.load();
    this.customizePanelOpen = false;
    this.snackBar.open('All dashboard sections are visible again.', 'Close', {
      duration: 3000,
    });
  }

  sessionStatusIcon(status: string): string {
    switch (status) {
      case 'completed':
        return 'check_circle';
      case 'failed':
        return 'error';
      case 'expired':
        return 'schedule';
      case 'cancelled':
        return 'cancel';
      case 'fetched':
        return 'download';
      default:
        return 'hourglass_empty';
    }
  }
}

/** A retention period in its largest whole unit, for example "24 hours" or "3 days". */
function formatDuration(seconds: number): string {
  const units: [number, string][] = [
    [86_400, 'day'],
    [3_600, 'hour'],
    [60, 'minute'],
  ];
  for (const [size, unit] of units) {
    if (seconds >= size && seconds % size === 0) {
      const count = seconds / size;
      return `${count} ${unit}${count === 1 ? '' : 's'}`;
    }
  }
  return `${seconds} seconds`;
}
