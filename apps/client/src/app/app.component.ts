import { BreakpointObserver, Breakpoints } from '@angular/cdk/layout';
import { Component, type OnDestroy, type OnInit, ChangeDetectionStrategy } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatMenuModule } from '@angular/material/menu';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatSnackBarModule } from '@angular/material/snack-bar';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { NavigationEnd, Router, RouterModule, RouterOutlet } from '@angular/router';
import { FlexLayoutModule } from 'ngx-flexible-layout';
import { Subscription } from 'rxjs';
import { filter } from 'rxjs/operators';
import { JwtService, Role } from './services/jwt.service';
import { ThemeService } from './services/theme.service';
import { VersionService } from './services/version.service';
import { ApiService } from './core';

@Component({
  selector: 'app-root',
  imports: [
    RouterOutlet,
    FlexLayoutModule,
    MatCardModule,
    MatButtonModule,
    MatToolbarModule,
    MatIconModule,
    MatSnackBarModule,
    MatTooltipModule,
    MatMenuModule,
    MatSidenavModule,
    MatListModule,
    MatDividerModule,
    RouterModule,
  ],
  templateUrl: './app.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './app.component.scss',
})
export class AppComponent implements OnInit, OnDestroy {
  logout() {
    this.apiService.logout();
    this.router.navigate(['/login']);
  }
  shouldShowToolbar = true;
  sidenavOpened = false;
  sidenavMode: 'over' | 'side' = 'side';
  private routerSubscription?: Subscription;
  private breakpointSubscription?: Subscription;

  constructor(
    private router: Router,
    public apiService: ApiService,
    private breakpointObserver: BreakpointObserver,
    public jwtService: JwtService,
    public themeService: ThemeService,
    public versionService: VersionService
  ) {}

  ngOnInit(): void {
    // Listen to route changes to determine when to show toolbar
    this.routerSubscription = this.router.events
      .pipe(filter((event) => event instanceof NavigationEnd))
      .subscribe((event: NavigationEnd) => {
        // Hide toolbar on login page, show on all other pages
        this.shouldShowToolbar = !event.url.includes('/login');
        this.checkBackendVersion();
      });

    // Initial check for current route
    this.shouldShowToolbar = !this.router.url.includes('/login');

    // Set up responsive behavior for sidenav
    this.breakpointSubscription = this.breakpointObserver
      .observe([Breakpoints.Handset])
      .subscribe((result) => {
        if (result.matches) {
          // Mobile: use overlay mode and close by default
          this.sidenavMode = 'over';
          this.sidenavOpened = false;
        } else {
          // Desktop: use side mode and open by default
          this.sidenavMode = 'side';
          this.sidenavOpened = true;
        }
      });
  }

  ngOnDestroy(): void {
    if (this.routerSubscription) {
      this.routerSubscription.unsubscribe();
    }
    if (this.breakpointSubscription) {
      this.breakpointSubscription.unsubscribe();
    }
  }

  /**
   * Compare client and backend builds once logged in, so a mismatch is visible on every page.
   */
  private checkBackendVersion(): void {
    if (this.shouldShowToolbar && this.apiService.getAuthenticationStatus()) {
      this.versionService.check(this.apiService.getBaseUrl());
    }
  }

  toggleSidenav(): void {
    this.sidenavOpened = !this.sidenavOpened;
  }

  /**
   * Close sidenav when navigating on mobile devices
   */
  closeSidenavOnMobile(): void {
    if (this.sidenavMode === 'over') {
      this.sidenavOpened = false;
    }
  }

  get canAutoRefresh(): boolean {
    return this.apiService.canRefreshToken();
  }

  navigateToClientManagement(): void {
    this.router.navigate(['/clients']);
  }

  /**
   * Check if user has permission to manage Keycloak clients
   */
  hasRole(role: Role | Role[]): boolean {
    if (Array.isArray(role)) {
      return role.some((r) => this.jwtService.hasRole(r));
    } else {
      return this.jwtService.hasRole(role);
    }
  }
}
