import { Component, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatIconModule } from '@angular/material/icon';
import { MatTableModule } from '@angular/material/table';
import { MatTooltipModule } from '@angular/material/tooltip';
import { RouterModule } from '@angular/router';
import { CredentialConfig } from '@eudiplo/sdk-core';
import { BaseAsyncListComponent } from '../../../common/base-async-list.component';
import { CredentialConfigService } from '../credential-config.service';
import { DisplayFormValue } from '../credential-config.types';
import { formatLifetime } from '../../../utils/duration';
import { ConfigOwnershipDirective } from '../../../config-portability/config-ownership.directive';
import { LoadErrorComponent } from '../../../common/load-error.component';
import { ItemRoutePipe } from '../../../common/item-route.pipe';
import { RoleLockDirective } from '../../../common/role-lock.directive';
import { ISSUANCE_WRITE_ROLES } from '../../../services/resource-roles';

@Component({
  selector: 'app-credential-config-list',
  imports: [
    ItemRoutePipe,
    MatTableModule,
    MatIconModule,
    MatButtonModule,
    MatCardModule,
    MatTooltipModule,
    FormsModule,
    RouterModule,
    ConfigOwnershipDirective,
    RoleLockDirective,
    LoadErrorComponent,
    MatProgressSpinnerModule,
  ],
  templateUrl: './credential-config-list.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './credential-config-list.component.scss',
})
export class CredentialConfigListComponent extends BaseAsyncListComponent<CredentialConfig> {
  /** Creating, changing and deleting it needs issuance:manage; reading needs less. */
  readonly writeRoles = ISSUANCE_WRITE_ROLES;

  protected readonly loadFailedMessage = 'Failed to load credential configs';

  get configs(): CredentialConfig[] {
    return this.items;
  }

  /** The configuration column also shows the description. */
  displayedColumns: string[] = ['id', 'format', 'lifeTime', 'features', 'actions'];

  constructor(private readonly credentialConfigService: CredentialConfigService) {
    super();
  }

  protected fetchItems(): Promise<CredentialConfig[]> {
    return this.credentialConfigService.loadConfigurations();
  }

  protected override searchTexts(config: CredentialConfig): string[] {
    return [
      config.id,
      this.getDescription(config),
      this.getFormat(config),
      config.config?.format ?? '',
    ];
  }

  protected override sortName(config: CredentialConfig): string {
    return config.id;
  }

  /** The wallet description of the first display entry, which is optional, else the configuration's own. */
  getDescription(config: CredentialConfig): string {
    return (
      (((config.config as any).display ?? []) as DisplayFormValue[])[0]?.description ||
      config.description ||
      'No description available'
    );
  }

  /** The credential format, such as "SD-JWT VC" or "mDOC". */
  getFormat(config: CredentialConfig): string {
    return config.config?.format === 'mso_mdoc' ? 'mDOC' : 'SD-JWT VC';
  }

  formatLifetime(seconds?: number | null): string {
    return formatLifetime(seconds);
  }

  deleteConfig(config: CredentialConfig): Promise<boolean> {
    return this.deleteItem({
      item: config,
      id: config.id,
      question: `Delete credential config "${config.id}"? This cannot be undone.`,
      request: () => this.credentialConfigService.deleteConfiguration(config.id),
      deleted: 'Configuration deleted successfully',
      failed: 'Failed to delete configuration',
    });
  }
}
