import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar } from '@angular/material/snack-bar';
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
import { getApiErrorMessage } from '../../../utils/error-message';
import { openErrorSnackBar } from '../../../utils/error-snackbar';
import { searchAndSort } from '../../../utils/search-list';
import { BaseAsyncListComponent } from '../../../common/base-async-list.component';
import { LoadErrorComponent } from '../../../common/load-error.component';
import { JwtService } from '../../../services/jwt.service';

@Component({
  selector: 'app-presentation-list',
  imports: [
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
  protected readonly loadFailedMessage = 'Failed to load presentation configurations';

  displayedColumns: (keyof PresentationConfig | 'actions' | 'registrationCert')[] = [
    'id',
    'description',
    'registrationCert',
    'createdAt',
    'actions',
  ];

  /** Short label of each registration certificate status, for its badge. */
  readonly registrationCertLabels = REGISTRATION_CERT_STATUS_LABELS;

  /** Text to find in a configuration's ID or description. */
  search = '';
  /** The last search result, kept until the configurations or the search change. */
  private shown?: {
    configurations: PresentationConfig[];
    search: string;
    result: PresentationConfig[];
  };

  /** The configuration whose delete runs; its Delete waits for it. */
  deletingId?: string;

  private readonly presentationService = inject(PresentationManagementService);
  private readonly snackBar = inject(MatSnackBar);
  private readonly jwtService = inject(JwtService);

  get configurations(): PresentationConfig[] {
    return this.items;
  }

  /** The configurations that match the search, sorted by ID. */
  get shownConfigurations(): PresentationConfig[] {
    if (this.shown?.configurations !== this.items || this.shown.search !== this.search) {
      const result = searchAndSort(
        this.items,
        this.search,
        (config) => [config.id, config.description ?? ''],
        (config) => config.id
      );
      this.shown = { configurations: this.items, search: this.search, result };
    }
    return this.shown.result;
  }

  clearSearch(): void {
    this.search = '';
  }

  protected fetchItems(): Promise<PresentationConfig[]> {
    return this.presentationService.loadConfigurations();
  }

  async deleteConfiguration(config: PresentationConfig): Promise<void> {
    if (
      this.deletingId === config.id ||
      !this.jwtService.hasRole('presentation:manage') ||
      !confirm(`Delete presentation configuration "${config.id}"? This cannot be undone.`)
    ) {
      return;
    }

    this.deletingId = config.id;
    try {
      await this.presentationService.deleteConfiguration(config.id);
      this.items = this.items.filter((c) => c.id !== config.id);
      this.snackBar.open('Presentation configuration deleted', 'Close', { duration: 3000 });
    } catch (error) {
      console.error('Error deleting configuration:', error);
      openErrorSnackBar(
        this.snackBar,
        getApiErrorMessage(error, 'Failed to delete presentation configuration')
      );
    } finally {
      this.deletingId = undefined;
    }
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
}
