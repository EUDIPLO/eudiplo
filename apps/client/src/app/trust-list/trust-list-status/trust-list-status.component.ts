import { DatePipe } from '@angular/common';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  ViewChild,
  inject,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTableModule } from '@angular/material/table';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ActivatedRoute, RouterModule } from '@angular/router';
import type { TrustListStatusResponseDto } from '@eudiplo/sdk-core';
import { BaseAsyncListComponent } from '../../common/base-async-list.component';
import { LoadErrorComponent } from '../../common/load-error.component';
import { TrustListService } from '../trust-list.service';
import {
  isTrustListRejected,
  isTrustListStatusStale,
  TRUST_LIST_STATUS_FRAGMENT,
  TRUST_LIST_STATUS_STALE_DAYS,
  trustListOutcomeLabels,
} from './trust-list-status';

/**
 * The trust lists the tenant has loaded, managed or external, with how their
 * last load ended, so a list that fails or lapses shows before credentials
 * are refused for it.
 */
@Component({
  selector: 'app-trust-list-status',
  imports: [
    DatePipe,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatTableModule,
    MatTooltipModule,
    RouterModule,
    LoadErrorComponent,
  ],
  templateUrl: './trust-list-status.component.html',
  styleUrl: './trust-list-status.component.scss',
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class TrustListStatusComponent extends BaseAsyncListComponent<TrustListStatusResponseDto> {
  protected readonly loadFailedMessage = 'Failed to load the status of the trust lists in use';
  protected readonly isRejected = isTrustListRejected;
  protected readonly isStale = (status: TrustListStatusResponseDto) =>
    isTrustListStatusStale(status);
  protected readonly staleDays = TRUST_LIST_STATUS_STALE_DAYS;
  readonly displayedColumns = ['outcome', 'list', 'checkedAt', 'nextUpdate', 'entities'];

  protected readonly headingId = TRUST_LIST_STATUS_FRAGMENT;
  @ViewChild('listHeading') private readonly heading?: ElementRef<HTMLElement>;
  private readonly route = inject(ActivatedRoute);
  private readonly sectionInjector = inject(Injector);

  constructor(private readonly trustListService: TrustListService) {
    super();
  }

  private loadedOnce = false;

  override async loadItems(): Promise<void> {
    const first = !this.loadedOnce;
    this.loadedOnce = true;
    await super.loadItems();
    // The section loads after the page, so the router cannot scroll to a link's fragment.
    if (first && this.route.snapshot.fragment === TRUST_LIST_STATUS_FRAGMENT) {
      afterNextRender(
        () => {
          // Focusing scrolls the heading into view as the page is laid out then.
          this.heading?.nativeElement.focus();
        },
        { injector: this.sectionInjector }
      );
    }
  }

  get statuses(): TrustListStatusResponseDto[] {
    return this.items;
  }

  protected fetchItems(): Promise<TrustListStatusResponseDto[]> {
    return this.trustListService.getStatus();
  }

  protected outcomeLabel(status: TrustListStatusResponseDto): string {
    return trustListOutcomeLabels[status.outcome];
  }

  /** The NextUpdate of the last verified list has passed; the next use fetches it again. */
  protected hasPassed(nextUpdate: string | null): boolean {
    if (!nextUpdate) return false;
    const time = Date.parse(nextUpdate);
    return !Number.isNaN(time) && time <= Date.now();
  }
}
