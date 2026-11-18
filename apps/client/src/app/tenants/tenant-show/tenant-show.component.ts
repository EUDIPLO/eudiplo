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

  async deleteTenant(): Promise<void> {
    const tenant = this.tenant;
    if (
      !tenant ||
      !confirm(`Delete tenant "${tenant.name}" and all its data? This cannot be undone.`)
    ) {
      return;
    }
    try {
      await tenantControllerDeleteTenant({ path: { id: tenant.id } });
    } catch (error) {
      console.error('Error deleting tenant:', error);
      openErrorSnackBar(this.snackBar, getApiErrorMessage(error, 'Failed to delete tenant'));
      return;
    }
    this.snackBar.open('Tenant deleted successfully', 'Close', { duration: 3000 });
    await this.router.navigate(['../'], { relativeTo: this.route });
  }
}

/** The tenant's own session, status list and key chain settings, as the detail page lists them. */
export function buildSettingGroups(tenant: TenantResponseDto): SettingGroup[] {
  const sessions = tenant.sessionConfig ?? {};
  const statusLists = tenant.statusListConfig ?? {};
  const keyChains = tenant.defaultKeyChains ?? {};
  const onOff = (value?: boolean) => (value === undefined ? undefined : value ? 'On' : 'Off');
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
          value:
            sessions.cleanupMode === 'anonymize'
              ? 'Personal data removed, metadata kept'
              : sessions.cleanupMode === 'full'
                ? 'Deleted completely'
                : undefined,
        },
      ],
    },
    {
      title: 'Status lists',
      icon: 'checklist',
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
          value:
            statusLists.immediateUpdate === undefined
              ? undefined
              : statusLists.immediateUpdate
                ? 'Immediately'
                : 'When the token expires',
        },
        { label: 'Aggregation', value: onOff(statusLists.enableAggregation) },
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
