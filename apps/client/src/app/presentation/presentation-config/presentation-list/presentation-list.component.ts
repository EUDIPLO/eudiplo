import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTableModule } from '@angular/material/table';
import { MatTooltipModule } from '@angular/material/tooltip';
import { RouterModule } from '@angular/router';
import { PresentationConfig } from '@eudiplo/sdk-core';
import { PresentationManagementService } from '../presentation-management.service';
import {
  formatRegistrationCertExpiresIn,
  getRegistrationCertStatus,
  getRegistrationCertTimes,
  REGISTRATION_CERT_STATUS_LABELS,
  registrationCertStatusSentence,
  type RegistrationCertStatus,
} from '../../../utils/registration-cert-status';
import { ConfigOwnershipDirective } from '../../../config-portability/config-ownership.directive';
import { BaseAsyncListComponent } from '../../../common/base-async-list.component';
import { LoadErrorComponent } from '../../../common/load-error.component';
import { ItemRoutePipe } from '../../../common/item-route.pipe';
import {
  ISSUER_TRUST_LABELS,
  issuerTrust,
  type IssuerTrustStatus,
} from '../dcql-query-editor/simple-dcql';

@Component({
  selector: 'app-presentation-list',
  imports: [
    ItemRoutePipe,
    MatTableModule,
    DatePipe,
    FormsModule,
    MatCardModule,
    MatIconModule,
    MatButtonModule,
    RouterModule,
    MatTooltipModule,
    ConfigOwnershipDirective,
    LoadErrorComponent,
    MatProgressSpinnerModule,
  ],
  templateUrl: './presentation-list.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './presentation-list.component.scss',
})
export class PresentationListComponent extends BaseAsyncListComponent<PresentationConfig> {
  protected readonly loadFailedMessage = 'Failed to load verification configs';

  displayedColumns: (keyof PresentationConfig | 'actions' | 'registrationCert' | 'issuerTrust')[] =
    ['id', 'description', 'issuerTrust', 'registrationCert', 'createdAt', 'actions'];

  /** Short label of each registration certificate status, for its badge. */
  readonly registrationCertLabels = REGISTRATION_CERT_STATUS_LABELS;

  private readonly presentationService = inject(PresentationManagementService);

  get configurations(): PresentationConfig[] {
    return this.items;
  }

  protected override searchTexts(config: PresentationConfig): string[] {
    return [config.id, config.description ?? ''];
  }

  protected override sortName(config: PresentationConfig): string {
    return config.id;
  }

  protected fetchItems(): Promise<PresentationConfig[]> {
    return this.presentationService.loadConfigurations();
  }

  deleteConfiguration(config: PresentationConfig): Promise<boolean> {
    return this.deleteItem({
      item: config,
      id: config.id,
      question: `Delete verification config "${config.id}"? This cannot be undone.`,
      request: () => this.presentationService.deleteConfiguration(config.id),
      deleted: 'Verification config deleted',
      failed: 'Failed to delete verification config',
    });
  }

  registrationCertStatus(config: PresentationConfig): RegistrationCertStatus {
    return getRegistrationCertStatus(config);
  }

  registrationCertTooltip(config: PresentationConfig): string {
    return (
      registrationCertStatusSentence(
        this.registrationCertStatus(config),
        formatRegistrationCertExpiresIn(getRegistrationCertTimes(config))
      ) ?? 'No registration certificate configured'
    );
  }

  /** Short label of each issuer trust status, for its badge. */
  readonly issuerTrustLabels = ISSUER_TRUST_LABELS;

  issuerTrustStatus(config: PresentationConfig): IssuerTrustStatus {
    return issuerTrust(config).status;
  }

  /** Why the badge is shown, naming the queries without issuer trust. */
  issuerTrustTooltip(config: PresentationConfig): string {
    const { status, queries } = issuerTrust(config);
    const ids = queries.join(', ');
    if (status === 'untrusted')
      return `Any issuer is accepted for ${ids}. The issuer's authority is not validated.`;
    if (status === 'refused')
      return `No issuer trust for ${ids}. Every presentation against this config is refused.`;
    return 'Every credential query names issuer trust';
  }
}
