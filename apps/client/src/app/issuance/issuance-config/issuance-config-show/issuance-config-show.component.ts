import { Component, OnInit, ChangeDetectionStrategy } from '@angular/core';
import { Clipboard, ClipboardModule } from '@angular/cdk/clipboard';
import { DatePipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatDividerModule } from '@angular/material/divider';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatTabsModule } from '@angular/material/tabs';
import { MatTableModule } from '@angular/material/table';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { RouterModule } from '@angular/router';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { FlexLayoutModule } from 'ngx-flexible-layout';
import { IssuanceConfig } from '@eudiplo/sdk-core';
import { downloadJsonFile } from '../../../common/download-json.util';
import {
  defaultAccessTokenLifetimeSeconds,
  IssuanceConfigService,
} from '../issuance-config.service';
import { ConfigOwnershipDirective } from '../../../config-portability/config-ownership.directive';
import { ConfigOwnershipNoticeComponent } from '../../../config-portability/config-ownership-notice.component';

interface ChainedAuthorizationServerView {
  enabled: boolean;
  upstream?: {
    issuer?: string;
    clientId?: string;
    scopes?: string[];
  };
  token?: {
    lifetimeSeconds?: number;
    refreshTokenEnabled?: boolean;
    refreshTokenExpiresInSeconds?: number;
  };
  requireDPoP?: boolean;
}

interface AuthorizationServerRow {
  label: string;
  id: string;
  type: string;
  preferred: boolean;
  enabled: boolean;
  dpop: string;
  tokenLifetime: number;
  refresh: string;
  details: string;
}

@Component({
  selector: 'app-issuance-config-show',
  imports: [
    MatIconModule,
    MatCardModule,
    MatButtonModule,
    MatTooltipModule,
    DatePipe,
    MatExpansionModule,
    MatChipsModule,
    MatDividerModule,
    MatListModule,
    MatTabsModule,
    MatTableModule,
    FlexLayoutModule,
    RouterModule,
    ClipboardModule,
    ConfigOwnershipDirective,
    ConfigOwnershipNoticeComponent,
  ],
  templateUrl: './issuance-config-show.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './issuance-config-show.component.scss',
})
export class IssuanceConfigShowComponent implements OnInit {
  config?: IssuanceConfig;
  reissuing = false;
  readonly authServerDisplayedColumns = [
    'label',
    'id',
    'type',
    'preferred',
    'enabled',
    'dpop',
    'token',
    'refresh',
    'details',
  ];

  constructor(
    private readonly issuanceConfigService: IssuanceConfigService,
    private readonly snackBar: MatSnackBar,
    private readonly clipboard: Clipboard
  ) {}

  get primaryDisplay(): any {
    return this.config?.display?.[0];
  }

  get externalAuthorizationServers(): string[] {
    const authorizationServers = (this.config as any)?.authorizationServers;
    if (Array.isArray(authorizationServers)) {
      return authorizationServers
        .filter((server: any) => server?.type === 'external' && typeof server?.issuer === 'string')
        .map((server: any) => server.issuer);
    }

    return [];
  }

  get hostedAuthorizationServers(): any[] {
    const authorizationServers = (this.config as any)?.authorizationServers;
    if (!Array.isArray(authorizationServers)) {
      return [];
    }

    return authorizationServers.filter((server: any) => server?.type === 'oid4vp');
  }

  get chainedAuthorizationServer(): ChainedAuthorizationServerView | undefined {
    const authorizationServers = (this.config as any)?.authorizationServers;
    if (Array.isArray(authorizationServers)) {
      const chained = authorizationServers.find(
        (server: any) => server?.type === 'chained' && server?.enabled !== false
      );
      if (chained) {
        return {
          enabled: true,
          upstream: {
            issuer: chained.upstream?.issuer,
            clientId: chained.upstream?.clientId,
            scopes: chained.upstream?.scopes,
          },
          token: {
            lifetimeSeconds: chained.token?.lifetimeSeconds,
            refreshTokenEnabled: chained.token?.refreshTokenEnabled,
            refreshTokenExpiresInSeconds: chained.token?.refreshTokenExpiresInSeconds,
          },
          requireDPoP: chained.requireDPoP,
        };
      }
    }

    return undefined;
  }

  get registrationCertificateConfig(): any {
    return (this.config as any)?.registrationCertificate;
  }

  get registrationCertificateCache(): any {
    return (this.config as any)?.registrationCertificateCache;
  }

  get registrationCertificateJwt(): string | null {
    const cacheJwt = this.registrationCertificateCache?.jwt;
    if (typeof cacheJwt === 'string' && cacheJwt.length > 0) {
      return cacheJwt;
    }

    const importedJwt = this.registrationCertificateConfig?.jwt;
    if (typeof importedJwt === 'string' && importedJwt.length > 0) {
      return importedJwt;
    }

    return null;
  }

  get registrationCertificateStatus(): 'none' | 'pending' | 'active' | 'expiring' | 'expired' {
    const cfg = this.registrationCertificateConfig;
    if (!cfg?.enabled) {
      return 'none';
    }

    const cache = this.registrationCertificateCache;
    if (!cache) {
      return 'pending';
    }

    const exp = cache.expiresAt;
    if (typeof exp === 'number') {
      const now = Math.floor(Date.now() / 1000);
      if (exp < now) {
        return 'expired';
      }

      const oneWeekSeconds = 7 * 24 * 60 * 60;
      if (exp - now < oneWeekSeconds) {
        return 'expiring';
      }
    }

    return 'active';
  }

  get parsedRegistrationCertHeader(): string {
    const jwt = this.registrationCertificateJwt;
    if (!jwt) return 'No registration certificate JWT available';

    try {
      return JSON.stringify(decodeProtectedHeader(jwt), null, 2);
    } catch (error) {
      return `Unable to decode JWT header: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  }

  get parsedRegistrationCertPayload(): string {
    const jwt = this.registrationCertificateJwt;
    if (!jwt) return 'No registration certificate JWT available';

    try {
      return JSON.stringify(decodeJwt(jwt), null, 2);
    } catch (error) {
      return `Unable to decode JWT payload: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  }

  get authorizationServerRows(): AuthorizationServerRow[] {
    const servers = ((this.config as any)?.authorizationServers ?? []) as any[];
    const rows = servers
      .filter((server) => {
        if (server?.type === 'external') {
          return typeof server?.issuer === 'string' && server.issuer.length > 0;
        }
        return (
          server?.type === 'oid4vp' || server?.type === 'chained' || server?.type === 'built-in'
        );
      })
      .map((server) => {
        if (server?.type === 'external') {
          return {
            label: server.label || server.issuer,
            id: server.id || '-',
            type: 'external',
            preferred: false,
            enabled: server.enabled !== false,
            dpop: '-',
            tokenLifetime: 0,
            refresh: '-',
            details: server.issuer,
          };
        }

        const refreshEnabled = server?.token?.refreshTokenEnabled ?? true;
        const refreshLifetime = server?.token?.refreshTokenExpiresInSeconds || 2592000;
        const isOid4vp = server?.type === 'oid4vp';
        const isBuiltIn = server?.type === 'built-in';
        return {
          label: server.label || server.id || 'Authorization Server',
          id: server.id || '-',
          type: server.type,
          preferred: false,
          enabled: server.enabled !== false,
          dpop: server.requireDPoP ? 'required' : 'optional',
          tokenLifetime:
            server?.token?.lifetimeSeconds || defaultAccessTokenLifetimeSeconds(server?.type),
          refresh: refreshEnabled ? `${refreshLifetime}s` : 'disabled',
          details: isBuiltIn
            ? 'issuer-local authorization server'
            : isOid4vp
              ? `presentation=${server.presentationConfigId || server.oid4vp?.presentationConfigId || 'n/a'}`
              : `issuer=${server.upstream?.issuer || 'n/a'}, client=${server.upstream?.clientId || 'n/a'}`,
        };
      });

    const preferredIndex = rows.findIndex((row) => row.enabled);
    if (preferredIndex >= 0) {
      rows[preferredIndex].preferred = true;
    }

    return rows;
  }

  copyToClipboard(value: string, label: string): void {
    this.clipboard.copy(value);
    this.snackBar.open(`${label} copied to clipboard`, 'Close', {
      duration: 2000,
    });
  }

  reissueRegistrationCertificate(): void {
    this.reissuing = true;
    this.issuanceConfigService
      .reissueRegistrationCertificate()
      .then((updated) => {
        this.config = updated;
        this.snackBar.open(
          'Registration certificate regenerated. Previous active certificate was revoked if present.',
          'Close',
          { duration: 3500 }
        );
      })
      .catch((error) => {
        console.error('Failed to regenerate issuer registration certificate', error);
        this.snackBar.open('Failed to regenerate registration certificate', 'Close', {
          duration: 4000,
        });
      })
      .finally(() => {
        this.reissuing = false;
      });
  }

  ngOnInit(): void {
    this.loadConfig();
  }

  private loadConfig(): void {
    this.issuanceConfigService.getConfig().then(
      (config) => {
        this.config = config;
      },
      (error) => {
        this.snackBar.open('Failed to load config', 'Close', {
          duration: 3000,
        });
        console.error('Load error:', error);
      }
    );
  }

  getObjectKeys(obj: any): string[] {
    return obj ? Object.keys(obj) : [];
  }

  formatDate(dateString?: string): string {
    if (!dateString) return 'Not set';
    return new Date(dateString).toLocaleString();
  }

  /**
   * Downloads the current configuration as a JSON file.
   */
  downloadConfig() {
    if (this.config) {
      downloadJsonFile(this.config, 'issuance-config.json');
    }
    this.snackBar.open('Configuration downloaded', 'Close', {
      duration: 3000,
    });
  }
}
