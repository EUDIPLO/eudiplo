import { CommonModule } from '@angular/common';
import { Component, OnInit, ChangeDetectionStrategy } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTableModule } from '@angular/material/table';
import { MatTooltipModule } from '@angular/material/tooltip';
import { RouterModule } from '@angular/router';
import { FlexLayoutModule } from 'ngx-flexible-layout';
import { KmsConfigDto, KmsProviderInfoDto } from '@eudiplo/sdk-core';
import { JsonViewDialogComponent } from '../../issuance/credential-config/credential-config-create/json-view-dialog/json-view-dialog.component';
import { kmsConfigSchema } from '../../utils/schemas';
import {
  KEY_ADMIN_FORBIDDEN_MESSAGE,
  KEY_ADMIN_ROLES,
  KeyChainService,
  isForbidden,
} from '../key-chain.service';
import { JwtService } from '../../services/jwt.service';
import { ConfigOwnershipDirective } from '../../config-portability/config-ownership.directive';
import { ConfigOwnershipNoticeComponent } from '../../config-portability/config-ownership-notice.component';

interface ProviderHealthItem {
  providerId: string;
  type: string;
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

interface ProviderRow {
  name: string;
  type: string;
  isDefault: boolean;
  canCreate: boolean;
  canImport: boolean;
  canDelete: boolean;
  supportedAlgs: string[];
  healthOk?: boolean;
  latencyMs?: number;
  healthError?: string;
}

@Component({
  selector: 'app-key-management-providers',
  standalone: true,
  imports: [
    CommonModule,
    MatButtonModule,
    MatCardModule,
    MatChipsModule,
    MatDialogModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatSnackBarModule,
    MatTableModule,
    MatTooltipModule,
    RouterModule,
    FlexLayoutModule,
    ConfigOwnershipDirective,
    ConfigOwnershipNoticeComponent,
  ],
  templateUrl: './key-management-providers.component.html',
  styleUrl: './key-management-providers.component.scss',
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class KeyManagementProvidersComponent implements OnInit {
  isLoading = false;
  isSavingConfig = false;
  defaultProvider = 'db';
  rows: ProviderRow[] = [];
  tenantConfig: KmsConfigDto = { providers: [] };
  hasTenantConfig = false;
  displayedColumns = ['name', 'type', 'capabilities', 'algorithms', 'health', 'actions'];

  constructor(
    private readonly keyChainService: KeyChainService,
    private readonly snackBar: MatSnackBar,
    private readonly dialog: MatDialog,
    private readonly jwtService: JwtService
  ) {}

  /**
   * The tenant KMS configuration contains provider credentials and is only
   * available to tenant administrators.
   */
  get canManageTenantConfig(): boolean {
    return this.jwtService.hasRole(KEY_ADMIN_ROLES);
  }

  ngOnInit(): void {
    this.loadProviders();
  }

  async refresh(): Promise<void> {
    await this.loadProviders();
  }

  private async loadProviders(): Promise<void> {
    this.isLoading = true;
    try {
      const [providersRes, healthRes] = await Promise.all([
        this.keyChainService.getProviders(),
        this.keyChainService.getProvidersHealth(),
      ]);

      this.defaultProvider = providersRes.default;
      const healthByProvider = new Map<string, ProviderHealthItem>();
      for (const h of healthRes) {
        healthByProvider.set(h.providerId, h);
      }

      this.rows = providersRes.providers.map((provider) =>
        this.toRow(provider, healthByProvider.get(provider.name))
      );

      if (this.canManageTenantConfig) {
        await this.loadTenantConfigEditor();
      }
    } catch (error) {
      console.error('Failed to load KMS providers:', error);
      this.snackBar.open('Failed to load KMS providers', 'Dismiss', { duration: 4000 });
    } finally {
      this.isLoading = false;
    }
  }

  async openTenantConfigEditor(): Promise<void> {
    const dialogRef = this.dialog.open(JsonViewDialogComponent, {
      data: {
        title: 'Tenant KMS Configuration JSON',
        jsonData: this.tenantConfig,
        readonly: false,
        schema: kmsConfigSchema,
      },
      disableClose: true,
      minWidth: '60vw',
      maxWidth: '95vw',
      maxHeight: '95vh',
    });

    dialogRef.afterClosed().subscribe(async (result) => {
      if (!result) {
        return;
      }

      await this.saveTenantConfig(result as KmsConfigDto);
    });
  }

  async saveTenantConfig(config: KmsConfigDto): Promise<void> {
    this.isSavingConfig = true;
    try {
      const result = await this.keyChainService.updateTenantKmsConfig(config);
      this.hasTenantConfig = !!result.tenantConfig;
      this.tenantConfig = this.editableConfig(result.tenantConfig);
      this.snackBar.open('Tenant KMS configuration saved', 'Dismiss', { duration: 3000 });
      await this.loadProviders();
    } catch (error) {
      console.error('Failed to save tenant KMS config:', error);
      this.snackBar.open(
        isForbidden(error)
          ? KEY_ADMIN_FORBIDDEN_MESSAGE
          : 'Failed to save tenant KMS configuration',
        'Dismiss',
        { duration: 4000 }
      );
    } finally {
      this.isSavingConfig = false;
    }
  }

  async resetTenantConfig(): Promise<void> {
    this.isSavingConfig = true;
    try {
      await this.keyChainService.deleteTenantKmsConfig();
      this.snackBar.open('Tenant KMS configuration reset to global defaults', 'Dismiss', {
        duration: 3000,
      });
      await this.loadProviders();
    } catch (error) {
      console.error('Failed to reset tenant KMS config:', error);
      this.snackBar.open(
        isForbidden(error)
          ? KEY_ADMIN_FORBIDDEN_MESSAGE
          : 'Failed to reset tenant KMS configuration',
        'Dismiss',
        { duration: 4000 }
      );
    } finally {
      this.isSavingConfig = false;
    }
  }

  private async loadTenantConfigEditor(): Promise<void> {
    const config = await this.keyChainService.getTenantKmsConfig();
    this.hasTenantConfig = !!config.tenantConfig;
    this.tenantConfig = this.editableConfig(config.tenantConfig);
  }

  /**
   * The editor holds only the tenant's own providers. Credentials arrive as
   * `<redacted>`; sent back unchanged, the backend keeps the stored value.
   * Global providers are not copied in: their credentials are not stored for
   * the tenant, so saving them would be rejected.
   */
  private editableConfig(tenantConfig: unknown): KmsConfigDto {
    return (tenantConfig as KmsConfigDto | null | undefined) ?? { providers: [] };
  }

  private toRow(provider: KmsProviderInfoDto, health?: ProviderHealthItem): ProviderRow {
    return {
      name: provider.name,
      type: provider.type,
      isDefault: provider.name === this.defaultProvider,
      canCreate: provider.capabilities.canCreate,
      canImport: provider.capabilities.canImport,
      canDelete: provider.capabilities.canDelete,
      supportedAlgs: provider.capabilities.supportedAlgs,
      healthOk: health?.ok,
      latencyMs: health?.latencyMs,
      healthError: health?.error,
    };
  }
}
