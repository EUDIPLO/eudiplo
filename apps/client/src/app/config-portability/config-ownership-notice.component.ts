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
import { JwtService } from '../services/jwt.service';
import {
  ConfigOwnershipService,
  ConfigResourceKind,
  ConfigResourceOwnership,
  offersApplyFromFile,
  offersResetToFile,
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
            @if (canManageOwnership) {
              <span>
                Edit {{ metadata?.source || 'the provisioning source' }} and apply it again. Direct
                changes and deletion are disabled. Generation {{ metadata?.generation }}.
                @if (offersApplyFromFile) {
                  If its file sets "secret": "!generate", choose Apply from file under Config
                  Portability to get a new secret.
                }
              </span>
            } @else {
              <span>
                Defined in {{ metadata?.source || 'the provisioning source' }}. Direct changes and
                deletion are disabled; ask someone with the tenant:admin role to change the file or
                detach the resource. Generation {{ metadata?.generation }}.
              </span>
            }
          </div>
          @if (canManageOwnership) {
            <a mat-button routerLink="/settings/config-portability">View ownership</a>
          }
        </mat-card-content>
      </mat-card>
    } @else if (metadata?.ownership === 'detached') {
      <mat-card appearance="outlined" class="managed-notice">
        <mat-card-content>
          <mat-icon>link_off</mat-icon>
          <div class="message">
            <strong>Detached from {{ metadata?.source || 'its configuration source' }}</strong>
            @if (!canReset) {
              <span>Imports from this source skip this resource.</span>
            } @else if (canManageOwnership) {
              <span>
                Startup imports skip this resource. Reset it to the file version to make it
                file-managed again.
                @if (kind === 'Tenant') {
                  The reset applies all tenant settings of info.json, such as the session and status
                  list settings.
                }
              </span>
            } @else {
              <span>
                Startup imports skip this resource. Someone with the tenant:admin role can reset it
                to the file version.
              </span>
            }
          </div>
          @if (canManageOwnership) {
            <a mat-button routerLink="/settings/config-portability">View ownership</a>
          }
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

  metadata?: ConfigResourceOwnership;
  /** Detach, reset and imports happen under Config Portability, like the sidebar entry. */
  canManageOwnership = false;

  get canReset(): boolean {
    return offersResetToFile(this.kind, this.metadata);
  }
  get offersApplyFromFile(): boolean {
    return offersApplyFromFile(this.kind, this.metadata);
  }
  private request = 0;

  constructor(
    private readonly ownership: ConfigOwnershipService,
    private readonly jwt: JwtService,
    private readonly changeDetector: ChangeDetectorRef
  ) {}

  ngOnChanges(): void {
    void this.refresh();
  }

  /** Loads the ownership again, for example after the resource was deleted on the same screen. */
  async refresh(): Promise<void> {
    const request = ++this.request;
    this.canManageOwnership = this.jwt.canUseConfigPortability();
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
