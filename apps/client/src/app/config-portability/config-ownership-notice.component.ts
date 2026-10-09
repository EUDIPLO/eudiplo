import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  Input,
  OnChanges,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { RouterModule } from '@angular/router';
import {
  ConfigOwnershipService,
  ConfigResourceKind,
  ConfigResourceMetadata,
} from './config-ownership.service';

@Component({
  selector: 'app-config-ownership-notice',
  standalone: true,
  imports: [MatButtonModule, MatCardModule, MatIconModule, RouterModule],
  template: `
    @if (metadata?.ownership === 'file-managed') {
      <mat-card appearance="outlined" class="managed-notice">
        <mat-card-content>
          <mat-icon>lock</mat-icon>
          <div class="message">
            <strong>Managed by a configuration bundle</strong>
            <span>
              Edit {{ metadata?.source || 'the provisioning source' }} and apply it again. Direct
              changes and deletion are disabled. Generation {{ metadata?.generation }}.
            </span>
          </div>
          <a mat-button routerLink="/settings/config-portability">View ownership</a>
        </mat-card-content>
      </mat-card>
    } @else if (metadata?.ownership === 'detached') {
      <mat-card appearance="outlined" class="managed-notice">
        <mat-card-content>
          <mat-icon>link_off</mat-icon>
          <div class="message">
            <strong>Detached from {{ metadata?.source || 'its configuration source' }}</strong>
            <span>
              Startup imports skip this resource. Reset it to the file version to make it
              file-managed again.
            </span>
          </div>
          <a mat-button routerLink="/settings/config-portability">View ownership</a>
        </mat-card-content>
      </mat-card>
    }
  `,
  styleUrl: './config-ownership-notice.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConfigOwnershipNoticeComponent implements OnChanges {
  @Input({ required: true }) kind!: ConfigResourceKind;
  @Input({ required: true }) resourceId = '';

  metadata?: ConfigResourceMetadata;
  private request = 0;

  constructor(
    private readonly ownership: ConfigOwnershipService,
    private readonly changeDetector: ChangeDetectorRef
  ) {}

  ngOnChanges(): void {
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    const request = ++this.request;
    if (!this.kind || !this.resourceId) {
      this.metadata = undefined;
      return;
    }
    try {
      const metadata = await this.ownership.get(this.kind, this.resourceId);
      if (request !== this.request) return;
      this.metadata = metadata;
      this.changeDetector.markForCheck();
    } catch {
      // Do not obscure the configuration screen if the advisory metadata call fails.
    }
  }
}
