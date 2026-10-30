import { Component, ChangeDetectionStrategy, type OnInit } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { RouterModule } from '@angular/router';
import { FlexLayoutModule } from 'ngx-flexible-layout';
import { ApiService } from '../../core';
import { OidcService } from '../../core/oidc.service';
import { FrontendConfigService } from '../../services/frontend-config.service';
import { formatBuild, VersionService } from '../../services/version.service';
import { copyToClipboard } from '../../utils/copy-to-clipboard';

@Component({
  selector: 'app-connection-settings',
  standalone: true,
  imports: [
    FlexLayoutModule,
    MatCardModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatIconModule,
    MatTooltipModule,
    MatSnackBarModule,
    RouterModule,
  ],
  templateUrl: './connection-settings.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './connection-settings.component.scss',
})
export class ConnectionSettingsComponent implements OnInit {
  constructor(
    public apiService: ApiService,
    public versionService: VersionService,
    public frontendConfigService: FrontendConfigService,
    private readonly oidcService: OidcService,
    private readonly snackBar: MatSnackBar
  ) {}

  private versionChecked = false;
  private importModeChecked = false;

  ngOnInit(): void {
    // Both reuse a result already loaded for this instance (the app shell checks the
    // version). Waiting for them tells a failed request from one that is still running.
    // Neither rejects: a failure leaves the value empty.
    void this.versionService
      .check(this.apiService.getBaseUrl())
      .finally(() => (this.versionChecked = true));
    void this.frontendConfigService.getConfig().finally(() => (this.importModeChecked = true));
  }

  get backendVersion(): string {
    const backend = this.versionService.backend;
    if (backend) return formatBuild(backend);
    return this.versionChecked ? 'Unavailable' : '…';
  }

  get clientVersion(): string {
    return formatBuild(this.versionService.client);
  }

  get importMode(): string {
    return (
      this.frontendConfigService.configImportMode ?? (this.importModeChecked ? 'Unavailable' : '…')
    );
  }

  get currentBaseUrl(): string {
    return this.apiService.getBaseUrl() || 'Not configured';
  }

  get currentClientId(): string {
    return this.apiService.getClientId() || 'Not configured';
  }

  /** Undefined without the secret, for example after a reload: it is kept in memory only. */
  get currentClientSecret(): string | undefined {
    return this.apiService.getClientSecret();
  }

  /** Shown instead of the secret: SSO uses none, and a reloaded tab no longer has it. */
  get missingSecretText(): string {
    return this.oidcService.mode === 'oidc' ? 'Not used with SSO' : 'Not available in this tab';
  }

  get currentOidcUrl(): string {
    return this.apiService.getoidcUrl() || 'Not configured';
  }

  get canAutoRefresh(): boolean {
    return this.apiService.canRefreshToken();
  }

  async copyField(text: string, label: string): Promise<void> {
    await copyToClipboard(
      this.snackBar,
      text,
      `${label} copied to clipboard`,
      `Could not copy the ${label}. Select it in its field and copy it by hand.`
    );
  }

  /** The secret field is masked, so the secret cannot be copied by hand. */
  async copySecret(secret: string): Promise<void> {
    await copyToClipboard(
      this.snackBar,
      secret,
      'Client Secret copied to clipboard',
      'Could not copy the Client Secret'
    );
  }
}
