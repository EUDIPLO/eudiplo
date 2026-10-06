import { Component, type OnDestroy, type OnInit, ChangeDetectionStrategy } from '@angular/core';
import { DatePipe } from '@angular/common';

import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Router, RouterModule } from '@angular/router';
import { FlexLayoutModule } from 'ngx-flexible-layout';
import { EnvironmentService } from '../services/environment.service';
import { JwtService } from '../services/jwt.service';
import { GrafanaLinkService } from '../services/grafana-link.service';
import { ApiService } from '../core';
import { MatGridListModule } from '@angular/material/grid-list';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { DashboardService } from './dashboard.service';
import { FrontendConfigService } from '../services/frontend-config.service';
import { VersionService } from '../services/version.service';
import {
  DashboardFocus,
  DashboardPreferences,
  DashboardPreferencesService,
  DashboardSection,
} from './dashboard-preferences.service';

interface DashboardFocusOption {
  value: DashboardFocus;
  label: string;
  description: string;
  icon: string;
  available: boolean;
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
    MatGridListModule,
    MatCheckboxModule,
    DatePipe,
    RouterModule,
  ],
  templateUrl: './dashboard.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: ['./dashboard.component.scss'],
})
export class DashboardComponent implements OnInit, OnDestroy {
  private readonly refreshInterval?: NodeJS.Timeout;
  private tokenCheckInterval?: NodeJS.Timeout;
  grafanaEnabled = false;
  customizePanelOpen = false;
  preferences: DashboardPreferences = {
    focus: 'balanced',
    visibleSections: {
      recentActivity: true,
      sessionOverview: true,
      quickActions: true,
      resources: true,
    },
  };

  constructor(
    public apiService: ApiService,
    public environmentService: EnvironmentService,
    public dashboardService: DashboardService,
    public grafanaLinkService: GrafanaLinkService,
    public frontendConfigService: FrontendConfigService,
    public jwtService: JwtService,
    public versionService: VersionService,
    private readonly router: Router,
    private readonly snackBar: MatSnackBar,
    private readonly dashboardPreferencesService: DashboardPreferencesService
  ) {}

  ngOnInit(): void {
    this.preferences = this.dashboardPreferencesService.load(this.defaultPreferences);
    if (!this.isFocusAvailable(this.preferences.focus)) {
      this.preferences = this.defaultPreferences;
      this.dashboardPreferencesService.save(this.preferences);
    }

    // Check token status periodically (every 30 seconds)
    this.tokenCheckInterval = setInterval(() => {
      this.checkTokenStatus();
    }, 30000);

    // Initial check
    this.checkTokenStatus();

    // Fetch backend version (no-op if the app shell already checked it)
    this.versionService.check(this.apiService.getBaseUrl());

    // Fetch dashboard stats
    this.dashboardService.getCounters();

    // Load Grafana config
    this.grafanaLinkService.getConfig().then(() => {
      this.grafanaEnabled = this.grafanaLinkService.isEnabled();
    });
    this.frontendConfigService.getConfig();
  }

  ngOnDestroy(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }
    if (this.tokenCheckInterval) {
      clearInterval(this.tokenCheckInterval);
    }
  }

  /**
   * Check token status and show warnings if needed
   */
  private checkTokenStatus(): void {
    if (!this.apiService.getAuthenticationStatus()) {
      // Token has expired, redirect to login
      this.snackBar
        .open('Your session has expired. Please login again.', 'Login', {
          duration: 0, // Don't auto-dismiss
          panelClass: ['error-snackbar'],
        })
        .onAction()
        .subscribe(() => {
          this.apiService.logout();
          this.router.navigate(['/login']);
        });
      return;
    }

    // Check if token is expiring soon (within 5 minutes) and can't auto-refresh
    const timeRemaining = this.apiService.getTokenTimeRemaining();
    if (timeRemaining < 300000 && !this.canAutoRefresh) {
      // 5 minutes
      const minutes = Math.floor(timeRemaining / 60000);
      this.snackBar.open(`Token expires in ${minutes} minutes. Please save your work.`, 'OK', {
        duration: 10000,
        panelClass: ['warning-snackbar'],
      });
    }
  }

  versionTooltip(label: string, revision?: string): string {
    const tooltip = revision
      ? `${label} version (commit ${revision.slice(0, 7)})`
      : `${label} version`;
    return this.versionService.compatibility === 'mismatch'
      ? `${tooltip} – client and backend come from different builds`
      : tooltip;
  }

  get currentBaseUrl(): string {
    return this.apiService.getBaseUrl() || 'Not configured';
  }

  get canAutoRefresh(): boolean {
    return this.apiService.canRefreshToken();
  }

  openGrafana(): void {
    const url = this.grafanaLinkService.getBaseUrl();
    if (url) {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }

  get focusOptions(): DashboardFocusOption[] {
    return [
      {
        value: 'balanced',
        label: 'Balanced',
        description: 'A broad view across configuration and operations',
        icon: 'dashboard',
        available: true,
      },
      {
        value: 'issuance',
        label: 'Issuance',
        description: 'Prioritize credential issuance workflows',
        icon: 'card_giftcard',
        available:
          this.dashboardService.canManageIssuance || this.jwtService.hasRole('issuance:offer'),
      },
      {
        value: 'verification',
        label: 'Verification',
        description: 'Prioritize presentation requests and verification',
        icon: 'fact_check',
        available:
          this.dashboardService.canManagePresentation ||
          this.jwtService.hasRole('presentation:request'),
      },
      {
        value: 'operations',
        label: 'Operations',
        description: 'Focus on health, sessions, and recent activity',
        icon: 'monitor_heart',
        available: this.dashboardService.canViewSessions,
      },
    ];
  }

  get focusLabel(): string {
    return this.focusOptions.find((option) => option.value === this.preferences.focus)?.label ?? '';
  }

  get readinessTitle(): string {
    if (this.dashboardService.isLoading) return 'Checking system readiness…';
    if (this.dashboardService.hasWarnings) {
      const count = this.dashboardService.warningMessages.length;
      return `${count} ${count === 1 ? 'item needs' : 'items need'} attention`;
    }
    if (this.dashboardService.isReadOnly) return 'Monitoring access';
    if (this.dashboardService.isSetupComplete) return 'Ready for wallet flows';
    return 'Setup incomplete';
  }

  get defaultPreferences(): DashboardPreferences {
    let focus: DashboardFocus = 'balanced';
    if (
      (this.dashboardService.canManageIssuance || this.jwtService.hasRole('issuance:offer')) &&
      !this.dashboardService.canManagePresentation &&
      !this.jwtService.hasRole('presentation:request')
    ) {
      focus = 'issuance';
    } else if (
      (this.dashboardService.canManagePresentation ||
        this.jwtService.hasRole('presentation:request')) &&
      !this.dashboardService.canManageIssuance &&
      !this.jwtService.hasRole('issuance:offer')
    ) {
      focus = 'verification';
    } else if (
      this.dashboardService.canViewSessions &&
      !this.dashboardService.canManageIssuance &&
      !this.dashboardService.canManagePresentation
    ) {
      focus = 'operations';
    }

    return this.preferencesForFocus(focus);
  }

  isSectionVisible(section: DashboardSection): boolean {
    return this.preferences.visibleSections[section];
  }

  setFocus(focus: DashboardFocus): void {
    if (!this.isFocusAvailable(focus)) return;
    this.preferences = this.preferencesForFocus(focus);
    this.persistPreferences();
  }

  setSectionVisibility(section: DashboardSection, visible: boolean): void {
    this.preferences = {
      ...this.preferences,
      visibleSections: { ...this.preferences.visibleSections, [section]: visible },
    };
    this.persistPreferences();
  }

  resetDashboard(): void {
    this.dashboardPreferencesService.reset();
    this.preferences = this.defaultPreferences;
    this.customizePanelOpen = false;
    this.snackBar.open('Dashboard reset to your role-based defaults.', 'Close', {
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

  private persistPreferences(): void {
    this.dashboardPreferencesService.save(this.preferences);
  }

  private preferencesForFocus(focus: DashboardFocus): DashboardPreferences {
    const visibleSections: Record<DashboardSection, boolean> = {
      recentActivity: true,
      sessionOverview: true,
      quickActions: true,
      resources: focus === 'balanced',
    };

    if (focus === 'operations') {
      visibleSections.quickActions = false;
    }

    return { focus, visibleSections };
  }

  private isFocusAvailable(focus: DashboardFocus): boolean {
    return this.focusOptions.some((option) => option.value === focus && option.available);
  }
}
