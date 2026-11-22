import { Component, OnInit, ChangeDetectionStrategy } from '@angular/core';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import {
  tenantControllerDeleteTenant,
  tenantControllerGetTenant,
  TenantResponseDto,
} from '@eudiplo/sdk-core';

import { ClientListComponent } from '../client/client-list/client-list.component';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatDividerModule } from '@angular/material/divider';
import { MatMenuModule } from '@angular/material/menu';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { LoadErrorComponent } from '../../common/load-error.component';
import { copyToClipboard } from '../../utils/copy-to-clipboard';
import { formatDuration } from '../../utils/duration';
import { getApiErrorMessage } from '../../utils/error-message';
import { openErrorSnackBar } from '../../utils/error-snackbar';
import { confirmTenantDelete } from '../tenant-delete-confirmation';

/** One setting of the tenant; without a value of its own, the instance's default applies. */
interface Setting {
  label: string;
  value?: string;
  /** Text instead of "Instance default", for settings that are chosen otherwise. */
  fallback?: string;
}

interface SettingGroup {
  title: string;
  icon: string;
  settings: Setting[];
}

@Component({
  selector: 'app-tenant-show',
  imports: [
    ClientListComponent,
    LoadErrorComponent,
    MatIconModule,
    RouterModule,
    MatButtonModule,
    MatCardModule,
    MatDividerModule,
    MatMenuModule,
    MatProgressSpinnerModule,
    MatSnackBarModule,
    MatTooltipModule,
  ],
  templateUrl: './tenant-show.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './tenant-show.component.scss',
})
export class TenantShowComponent implements OnInit {
  tenant?: TenantResponseDto;
  /** Set when the tenant could not be loaded, so the page does not stay empty. */
  loadError = '';
  /** True while the delete request runs, so it is not sent twice. */
  deleting = false;
  /** The tenant's settings, built once it has loaded. */
  settingGroups: SettingGroup[] = [];

  constructor(
    private readonly route: ActivatedRoute,
    private readonly router: Router,
    private readonly snackBar: MatSnackBar
  ) {}

  ngOnInit(): void {
    void this.loadTenant();
  }

  async loadTenant(): Promise<void> {
    this.loadError = '';
    const id = this.route.snapshot.paramMap.get('id');
    if (!id) {
      this.loadError = 'The address names no tenant.';
      return;
    }

    try {
      this.tenant = await tenantControllerGetTenant<true>({ path: { id } }).then((res) => res.data);
      this.settingGroups = buildSettingGroups(this.tenant);
    } catch (error) {
      console.error('Failed to load tenant details:', error);
      this.loadError = getApiErrorMessage(error, 'Failed to load tenant');
    }
  }

  /** First letter of the name, or of the ID without a name, for the avatar. */
  get initial(): string {
    return (this.tenant?.name || this.tenant?.id || '').charAt(0);
  }

  async copyId(): Promise<void> {
    if (!this.tenant) return;
    await copyToClipboard(
      this.snackBar,
      this.tenant.id,
      'Tenant ID copied to clipboard',
      'Could not copy the tenant ID'
    );
  }

  /** Deletes the tenant once its ID was typed, then returns to the list. */
  async deleteTenant(): Promise<void> {
    const tenant = this.tenant;
    if (!tenant || this.deleting) return;
    if (!confirmTenantDelete(this.snackBar, tenant)) return;
    this.deleting = true;
    try {
      await tenantControllerDeleteTenant({ path: { id: tenant.id } });
    } catch (error) {
      console.error('Error deleting tenant:', error);
      openErrorSnackBar(this.snackBar, getApiErrorMessage(error, 'Failed to delete tenant'));
      return;
    } finally {
      this.deleting = false;
    }
    this.snackBar.open('Tenant deleted successfully', 'Close', { duration: 3000 });
    await this.router.navigate(['../'], { relativeTo: this.route });
  }
}

/** What happens to a session once it is no longer kept. */
const cleanupLabels: Record<'full' | 'anonymize', string> = {
  full: 'Deleted completely',
  anonymize: 'Personal data removed, metadata kept',
};

/** One of two labels for a setting that is on or off; undefined while unset. */
function booleanLabel(value: boolean | undefined, on: string, off: string): string | undefined {
  if (value === undefined) return undefined;
  return value ? on : off;
}

/** The tenant's own session, status list and key chain settings, as the detail page lists them. */
export function buildSettingGroups(tenant: TenantResponseDto): SettingGroup[] {
  const sessions = tenant.sessionConfig ?? {};
  const statusLists = tenant.statusListConfig ?? {};
  const keyChains = tenant.defaultKeyChains ?? {};
  return [
    {
      title: 'Sessions',
      icon: 'history',
      settings: [
        {
          label: 'Kept for',
          value: sessions.ttlSeconds ? formatDuration(sessions.ttlSeconds) : undefined,
        },
        {
          label: 'Afterwards',
          value: sessions.cleanupMode ? cleanupLabels[sessions.cleanupMode] : undefined,
        },
      ],
    },
    {
      title: 'Status lists',
      icon: 'format_list_bulleted',
      settings: [
        { label: 'Capacity', value: statusLists.capacity?.toLocaleString() },
        {
          label: 'Bits per entry',
          value: statusLists.bits === undefined ? undefined : String(statusLists.bits),
        },
        {
          label: 'Token lifetime',
          value: statusLists.ttl ? formatDuration(statusLists.ttl) : undefined,
        },
        {
          label: 'New token after a change',
          value: booleanLabel(statusLists.immediateUpdate, 'Immediately', 'When the token expires'),
        },
        { label: 'Aggregation', value: booleanLabel(statusLists.enableAggregation, 'On', 'Off') },
      ],
    },
    {
      title: 'Default key chains',
      icon: 'key',
      settings: [
        { label: 'Access', value: keyChains.access, fallback: 'Chosen by rule' },
        {
          label: 'Authorization server',
          value: keyChains.authorizationServer,
          fallback: 'Oldest of the tenant',
        },
      ],
    },
  ];
}
