import { Component, ChangeDetectionStrategy } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatIconModule } from '@angular/material/icon';
import { MatTableModule } from '@angular/material/table';
import { MatTooltipModule } from '@angular/material/tooltip';
import { RouterModule } from '@angular/router';
import { FlexLayoutModule } from 'ngx-flexible-layout';
import { CredentialConfig } from '@eudiplo/sdk-core';
import { BaseAsyncListComponent } from '../../../common/base-async-list.component';
import { CredentialConfigService } from '../credential-config.service';
import { DisplayFormValue } from '../credential-config.types';
import { ConfigOwnershipDirective } from '../../../config-portability/config-ownership.directive';
import { JwtService } from '../../../services/jwt.service';
import { LoadErrorComponent } from '../../../common/load-error.component';

@Component({
  selector: 'app-credential-config-list',
  imports: [
    MatTableModule,
    MatIconModule,
    MatButtonModule,
    MatTooltipModule,
    RouterModule,
    FlexLayoutModule,
    ConfigOwnershipDirective,
    LoadErrorComponent,
    MatProgressSpinnerModule,
  ],
  templateUrl: './credential-config-list.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './credential-config-list.component.scss',
})
export class CredentialConfigListComponent extends BaseAsyncListComponent<CredentialConfig> {
  protected readonly loadFailedMessage = 'Failed to load credential configurations';

  get configs(): CredentialConfig[] {
    return this.items;
  }

  displayedColumns: (keyof CredentialConfig | 'description' | 'schemaMetadata' | 'actions')[] = [
    'id',
    'description',
    'schemaMetadata',
    'keyBinding',
    'lifeTime',
    'embeddedDisclosurePolicy',
    'statusManagement',
    'actions',
  ];

  constructor(
    private readonly credentialConfigService: CredentialConfigService,
    private readonly jwtService: JwtService
  ) {
    super();
  }

  /** The schema pages need `registrar:manage`; without it the badge link would end in "Access denied". */
  get canOpenSchemas(): boolean {
    return this.jwtService.hasRole('registrar:manage');
  }

  protected fetchItems(): Promise<CredentialConfig[]> {
    return this.credentialConfigService.loadConfigurations();
  }

  /** The wallet description of the first display entry, which is optional, else the configuration's own. */
  getDescription(config: CredentialConfig): string {
    return (
      ((config.config as any).display as DisplayFormValue[])[0]?.description ||
      config.description ||
      'No description available'
    );
  }

  getSchemaMetadataId(config: CredentialConfig): string | null {
    const id = (config as any)?.schemaMeta?.id;
    return typeof id === 'string' && id.trim().length > 0 ? id.trim() : null;
  }
}
