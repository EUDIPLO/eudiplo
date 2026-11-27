import { CommonModule } from '@angular/common';
import { Component, type OnInit, ChangeDetectionStrategy } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTableModule } from '@angular/material/table';
import { MatCardModule } from '@angular/material/card';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatChipsModule } from '@angular/material/chips';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { RouterModule } from '@angular/router';
import { type DefaultAccessKeyChainDto, KeyChainResponseDto } from '@eudiplo/sdk-core';
import { KEY_ADMIN_ROLE, KeyChainService } from '../key-chain.service';
import { ConfigOwnershipDirective } from '../../config-portability/config-ownership.directive';
import { LoadErrorComponent } from '../../common/load-error.component';
import { getApiErrorMessage } from '../../utils/error-message';
import { openErrorSnackBar } from '../../utils/error-snackbar';
import { keyChainDeleteConsequence, keyChainDeleteQuestion } from '../key-chain-delete-question';
import { keyChainRotateQuestion } from '../key-chain-rotate-question';
import {
  changeDefaultAccess,
  defaultAccessChip,
  defaultAccessDeleteRefusal,
  defaultAccessToggleLabel,
  defaultAccessToggleTooltip,
  isConfiguredDefaultAccess,
  loadDefaultAccess,
  missingDefaultAccessMessage,
} from '../default-access-key-chain';
import { keyUsages, type KeyUsageType } from '../key-usage';
import { ItemRoutePipe } from '../../common/item-route.pipe';
import { RoleLockDirective } from '../../common/role-lock.directive';
import { JwtService } from '../../services/jwt.service';

/**
 * Display item for key chains.
 */
interface KeyDisplayItem {
  id: string;
  description?: string;
  usageType: KeyUsageType;
  type: 'internalChain' | 'standalone';
  rotationEnabled: boolean;
  hasRootCa: boolean;
  kmsProvider: string;
  keyChain: KeyChainResponseDto;
}

@Component({
  selector: 'app-key-management-list',
  imports: [
    ItemRoutePipe,
    CommonModule,
    MatIconModule,
    MatButtonModule,
    MatSnackBarModule,
    MatTooltipModule,
    MatCardModule,
    MatMenuModule,
    MatTableModule,
    MatChipsModule,
    MatProgressSpinnerModule,
    RouterModule,
    ConfigOwnershipDirective,
    RoleLockDirective,
    LoadErrorComponent,
  ],
  templateUrl: './key-management-list.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './key-management-list.component.scss',
})
export class KeyManagementListComponent implements OnInit {
  displayItems: KeyDisplayItem[] = [];
  isLoading = true;
  /** Key chains whose delete request runs, so it is not sent twice. */
  readonly deletingIds = new Set<string>();
  /** Key chains whose rotation request runs, so a second click does not rotate again. */
  readonly rotatingIds = new Set<string>();
  /** Set when the keys could not be loaded, so the page does not claim there are none. */
  loadError = '';
  /**
   * The tenant's default access key chain; undefined when it could not be loaded, so no row is
   * marked and no default can be changed.
   */
  defaultAccess?: DefaultAccessKeyChainDto;
  /** True while a request that changes the default access key chain runs. */
  updatingDefault = false;
  filteredItems: KeyDisplayItem[] = [];
  /** The name column also shows the ID and the default mark. */
  displayedColumns: string[] = ['name', 'usage', 'type', 'kmsProvider', 'rotation', 'actions'];
  /** The usage filter chips with the number of key chains of each usage; only usages in use. */
  usageFilters: { value: KeyUsageType; label: string; count: number }[] = [];
  readonly keyTypes: { value: KeyDisplayItem['type']; label: string }[] = [
    { value: 'internalChain', label: 'Internal Chain' },
    { value: 'standalone', label: 'Standalone' },
  ];

  selectedUsageType = '';
  selectedKeyType = '';
  selectedKmsProvider = '';
  availableKmsProviders: string[] = [];

  private readonly usageConfig = keyUsages;

  /** Creating, changing, rotating and deleting key chains and the default need it. */
  readonly keyAdminRole = KEY_ADMIN_ROLE;

  constructor(
    private readonly keyChainService: KeyChainService,
    private readonly snackBar: MatSnackBar,
    private readonly jwtService: JwtService
  ) {}

  /** Whether the caller may create, change, rotate and delete key chains. */
  get canManageKeyChains(): boolean {
    return this.jwtService.hasRole(KEY_ADMIN_ROLE);
  }

  ngOnInit(): void {
    void this.loadAllKeys();
  }

  async loadAllKeys(): Promise<void> {
    this.isLoading = true;
    this.loadError = '';
    try {
      const keyChains = await this.keyChainService.getAll();
      // The list stays usable without the default; it then marks no row. Loaded after the keys,
      // so a backend that cannot be reached is reported once, by the load error.
      const defaultAccess = await loadDefaultAccess(this.keyChainService, this.snackBar);
      this.defaultAccess = defaultAccess;

      this.displayItems = this.convertKeyChains(keyChains);
      this.availableKmsProviders = [...new Set(this.displayItems.map((item) => item.kmsProvider))]
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));
      this.usageFilters = this.countUsages();
      this.applyFilters();
    } catch (error) {
      console.error('Error loading keys:', error);
      this.loadError = getApiErrorMessage(error, 'Failed to load keys');
    } finally {
      this.isLoading = false;
    }
  }

  private convertKeyChains(keyChains: KeyChainResponseDto[]): KeyDisplayItem[] {
    return keyChains.map((kc) => ({
      id: kc.id,
      description: kc.description,
      usageType: kc.usageType as KeyUsageType,
      type: kc.type,
      rotationEnabled: kc.rotationPolicy?.enabled || false,
      hasRootCa: kc.type === 'internalChain' && !!kc.rootCertificate,
      kmsProvider: kc.kmsProvider,
      keyChain: kc,
    }));
  }

  onFilterChange(): void {
    this.applyFilters();
  }

  selectUsage(value: string): void {
    this.selectedUsageType = value;
    this.applyFilters();
  }

  selectKeyType(value: string): void {
    this.selectedKeyType = value;
    this.applyFilters();
  }

  selectKmsProvider(value: string): void {
    this.selectedKmsProvider = value;
    this.applyFilters();
  }

  get hasFilters(): boolean {
    return !!(this.selectedUsageType || this.selectedKeyType || this.selectedKmsProvider);
  }

  /** The chosen key type for its menu button, such as "Standalone", or "All". */
  get keyTypeFilterLabel(): string {
    return this.keyTypes.find((type) => type.value === this.selectedKeyType)?.label ?? 'All';
  }

  /** The usages in use, in the order of the usage configuration, with their counts. */
  private countUsages(): { value: KeyUsageType; label: string; count: number }[] {
    return (Object.keys(this.usageConfig) as KeyUsageType[])
      .map((value) => ({
        value,
        label: this.usageConfig[value].short,
        count: this.displayItems.filter((item) => item.usageType === value).length,
      }))
      .filter((usage) => usage.count > 0);
  }

  clearFilters(): void {
    this.selectedUsageType = '';
    this.selectedKeyType = '';
    this.selectedKmsProvider = '';
    this.applyFilters();
  }

  private applyFilters(): void {
    this.filteredItems = this.displayItems.filter((item) => {
      const usageMatches = !this.selectedUsageType || item.usageType === this.selectedUsageType;
      const typeMatches = !this.selectedKeyType || item.type === this.selectedKeyType;
      const kmsMatches = !this.selectedKmsProvider || item.kmsProvider === this.selectedKmsProvider;

      return usageMatches && typeMatches && kmsMatches;
    });
  }

  getDisplayName(item: KeyDisplayItem): string {
    return item.description || item.id;
  }

  getUsageLabel(item: KeyDisplayItem): string {
    return this.usageConfig[item.usageType]?.label ?? item.usageType;
  }

  /** The usage with "Keys" left out, as the table shows it next to the usage icon. */
  getUsageShortLabel(item: KeyDisplayItem): string {
    return this.usageConfig[item.usageType]?.short ?? item.usageType;
  }

  getUsageIcon(item: KeyDisplayItem): string {
    return this.usageConfig[item.usageType]?.icon ?? 'key';
  }

  getTypeLabel(item: KeyDisplayItem): string {
    return item.type === 'internalChain' ? 'Internal Chain' : 'Standalone';
  }

  getTypeIcon(item: KeyDisplayItem): string {
    if (item.type === 'internalChain') {
      return 'account_tree';
    }
    return item.rotationEnabled ? 'autorenew' : 'key';
  }

  async deleteItem(item: KeyDisplayItem, event: Event): Promise<void> {
    event.stopPropagation();
    if (!this.canManageKeyChains || this.deletingIds.has(item.id)) return;

    // The backend refuses it; say so instead of asking first.
    const refusal = defaultAccessDeleteRefusal(this.defaultAccess, item.id);
    if (refusal) {
      openErrorSnackBar(this.snackBar, refusal, 'Dismiss');
      return;
    }

    if (
      !confirm(
        keyChainDeleteQuestion(item.id, item.description) +
          keyChainDeleteConsequence(item.usageType)
      )
    ) {
      return;
    }

    this.deletingIds.add(item.id);
    try {
      await this.keyChainService.delete(item.id);
      this.snackBar.open('Key chain deleted', 'Dismiss', { duration: 3000 });
      await this.loadAllKeys();
    } catch (error) {
      console.error('Error deleting key chain:', error);
      openErrorSnackBar(
        this.snackBar,
        getApiErrorMessage(error, 'Failed to delete key chain'),
        'Dismiss'
      );
    } finally {
      this.deletingIds.delete(item.id);
    }
  }

  defaultChip(item: KeyDisplayItem): { label: string; tooltip: string } | undefined {
    return defaultAccessChip(this.defaultAccess, item.id);
  }

  /** Whether the row offers to set or remove the default access key chain. */
  canToggleDefault(item: KeyDisplayItem): boolean {
    return item.usageType === 'access' && this.defaultAccess !== undefined;
  }

  isDefault(item: KeyDisplayItem): boolean {
    return isConfiguredDefaultAccess(this.defaultAccess, item.id);
  }

  defaultToggleTooltip(item: KeyDisplayItem): string {
    return defaultAccessToggleTooltip(this.defaultAccess, item.id);
  }

  defaultToggleLabel(item: KeyDisplayItem): string {
    return defaultAccessToggleLabel(this.defaultAccess, item.id, this.getDisplayName(item));
  }

  /** Set when the tenant's default access key chain no longer exists. */
  get missingDefaultMessage(): string | undefined {
    return missingDefaultAccessMessage(this.defaultAccess);
  }

  /** Makes the key chain the tenant's default access key chain, or removes it as default. */
  async toggleDefault(item: KeyDisplayItem, event: Event): Promise<void> {
    event.stopPropagation();
    if (!this.canManageKeyChains || !this.canToggleDefault(item)) return;
    await this.setDefault(this.isDefault(item) ? null : item.id);
  }

  /** Sets the default access key chain, or with null removes it; keeps the state on failure. */
  async setDefault(keyChainId: string | null): Promise<void> {
    if (!this.canManageKeyChains || this.updatingDefault) return;
    this.updatingDefault = true;
    try {
      this.defaultAccess =
        (await changeDefaultAccess(this.keyChainService, this.snackBar, keyChainId)) ??
        this.defaultAccess;
    } finally {
      this.updatingDefault = false;
    }
  }

  async rotateItem(item: KeyDisplayItem, event: Event): Promise<void> {
    event.stopPropagation();
    if (!this.canManageKeyChains || this.rotatingIds.has(item.id)) return;

    if (!item.rotationEnabled) {
      this.snackBar.open('Rotation not enabled for this key chain', 'Dismiss', { duration: 3000 });
      return;
    }

    if (!confirm(keyChainRotateQuestion(item.keyChain))) return;

    this.rotatingIds.add(item.id);
    try {
      await this.keyChainService.rotate(item.id);
      this.snackBar.open('Key chain rotated', 'Dismiss', { duration: 3000 });
      await this.loadAllKeys();
    } catch (error) {
      console.error('Error rotating key chain:', error);
      openErrorSnackBar(
        this.snackBar,
        getApiErrorMessage(error, 'Failed to rotate key chain'),
        'Dismiss'
      );
    } finally {
      this.rotatingIds.delete(item.id);
    }
  }
}
