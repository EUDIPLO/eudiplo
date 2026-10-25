import { Injectable } from '@angular/core';
import {
  credentialConfigControllerGetConfigs,
  presentationManagementControllerConfiguration,
  sessionControllerGetAllSessions,
  sessionControllerGetSessionStats,
  defaultAccessKeyChainControllerGet,
  type DefaultAccessKeyChainDto,
  keyChainControllerGetAll,
  keyChainControllerGetProvidersHealth,
  issuanceConfigControllerGetIssuanceConfigurations,
  registrarControllerGetConfig,
  trustListControllerGetAllTrustLists,
  KeyChainResponseDto,
  ProviderHealthResponseDto,
  Session,
  SessionStatsResponseDto,
  SessionRetentionDto,
  SessionStatusCountsDto,
} from '@eudiplo/sdk-core';
import { JwtService } from '../services/jwt.service';
import { SESSION_READER_ROLES } from '../session-management/session-roles';
import { KEY_CHAIN_ROLES } from '../key-management/key-chain.service';
import { apiErrorDetail, groupUnreachable, hasHttpStatus } from '../utils/error-message';
import { lastDays, lastHours } from '../utils/local-day';

type AccessCertificateStatus = 'missing' | 'expired' | 'expiring' | 'healthy';

/** One backend request of the dashboard. */
export type DashboardSource =
  | 'keyChains'
  | 'credentials'
  | 'issuance'
  | 'presentations'
  | 'trustLists'
  | 'registrar'
  | 'sessionStats'
  | 'recentSessions'
  | 'activity'
  | 'window'
  | 'kmsHealth';

const sourceLabels: Record<DashboardSource, string> = {
  keyChains: 'key chains',
  credentials: 'credential configs',
  issuance: 'issuer settings',
  presentations: 'presentation configs',
  trustLists: 'trust lists',
  registrar: 'registrar config',
  sessionStats: 'session counts',
  recentSessions: 'recent sessions',
  activity: 'session activity',
  window: 'session counts of the activity window',
  kmsHealth: 'KMS health',
};

const TOP_FAILURE_CODES = 5;
/** Requests that start from the result of the session counts request. */
const DERIVED_FROM_STATS = new Set<DashboardSource>(['activity', 'window']);
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Longest activity window the dashboard shows. */
const MAX_WINDOW_DAYS = 7;

/**
 * The time range of the activity chart and the window KPIs. Sessions deleted by
 * the retention cleanup no longer count, so the window never reaches further back
 * than the tenant keeps sessions.
 */
export interface ActivityWindow {
  unit: 'day' | 'hour';
  /** Bucket starts, oldest first; the last bucket is the current day or hour. */
  starts: Date[];
  /** For labels, for example "7 days" or "24 hours". */
  label: string;
  /** True when retention, not the dashboard's maximum, limits the window. */
  limitedByRetention: boolean;
}

/** Daily buckets for at least two days of kept sessions, hourly buckets otherwise. */
export function activityWindow(retention: SessionRetentionDto, now = new Date()): ActivityWindow {
  const keepsAll = retention.cleanupMode === 'anonymize';
  const keptMs = retention.ttlSeconds * 1000;
  const days = keepsAll ? MAX_WINDOW_DAYS : Math.min(MAX_WINDOW_DAYS, Math.floor(keptMs / DAY_MS));
  if (days >= 2) {
    return {
      unit: 'day',
      starts: lastDays(days, now),
      label: `${days} days`,
      limitedByRetention: days < MAX_WINDOW_DAYS,
    };
  }
  const hours = Math.max(1, Math.min(24, Math.floor(keptMs / HOUR_MS)));
  return {
    unit: 'hour',
    starts: lastHours(hours, now),
    label: hours === 1 ? 'hour' : `${hours} hours`,
    limitedByRetention: true,
  };
}

/** Session counts of the sessions created in one bucket of the activity window. */
export interface BucketStats {
  start: Date;
  stats: SessionStatsResponseDto;
}

/** Outcome of the sessions created in one bucket; not completed covers expired, cancelled and open ones. */
export interface ActivityBucket {
  start: Date;
  total: number;
  completed: number;
  failed: number;
  notCompleted: number;
}

export interface DashboardWarning {
  message: string;
  /** Route to the page that fixes the cause. */
  action?: { label: string; route: string[] };
  /** The cause is a failed request that loading again may fix. */
  retry?: boolean;
}

/** Network errors, timeouts, rate limits and server errors can pass on a retry. */
function isRetryable(error: unknown): boolean {
  const status = (error as { statusCode?: unknown } | null | undefined)?.statusCode;
  return typeof status !== 'number' || status >= 500 || status === 408 || status === 429;
}

@Injectable({
  providedIn: 'root',
})
export class DashboardService {
  private readonly accessCertificateExpiringSoonDays = 30;
  private readonly loadedSources = new Set<DashboardSource>();
  /** Why each failed request failed. */
  private readonly failedSources = new Map<DashboardSource, unknown>();
  private loadId = 0;

  credentialConfigs = 0;
  presentationConfigs = 0;
  /** Only holds the session types the user may read. */
  sessionStats: Partial<SessionStatsResponseDto> = {};
  totalKeyChains = 0;
  accessKeyChains = 0;
  /** The access key chain whose certificate needs attention, or the one in use. */
  accessKeyChainId: string | null = null;
  hasActiveAccessCertificate = false;
  hasUsableAccessCertificate = false;
  accessCertificateStatus: AccessCertificateStatus = 'missing';
  /** True when the tenant names a default access key chain that no longer exists. */
  defaultAccessKeyChainMissing = false;
  accessCertificateExpiresAt: string | null = null;
  accessCertificateDaysUntilExpiry: number | null = null;
  trustListCount = 0;
  hasTrustList = false;
  hasRegistrarConfig = false;
  hasIssuanceConfig = false;
  recentSessions: Session[] = [];
  /** The window of the activity chart and the window KPIs, once the retention is known. */
  activity: ActivityWindow | null = null;
  /** Session counts per bucket of the activity window, oldest first. */
  bucketStats: BucketStats[] = [];
  /**
   * Session counts of the whole window. The KPIs link to the session list from the
   * window's first day, since the list filters by day.
   */
  windowStats: Partial<SessionStatsResponseDto> = {};
  kmsProviders: ProviderHealthResponseDto[] = [];
  isLoading = true;
  /** When the last load finished. */
  lastUpdatedAt: Date | null = null;

  constructor(private readonly jwtService: JwtService) {}

  /**
   * Loads all dashboard data the user's roles allow. With `keepPrevious` the
   * previous values stay visible until the new ones arrive; a first load
   * starts empty, so no data of a previously signed-in user shows.
   */
  async getCounters({ keepPrevious = false } = {}): Promise<void> {
    const loadId = ++this.loadId;
    this.isLoading = true;
    if (!keepPrevious) {
      this.reset();
      this.lastUpdatedAt = null;
    }

    // Build list of promises based on user roles
    const promises: Promise<any>[] = [];
    const promiseKeys: DashboardSource[] = [];

    if (this.canManageKeyChains) {
      promises.push(
        Promise.all([
          keyChainControllerGetAll(),
          // Without it the card checks every access key chain, as for a tenant without default.
          defaultAccessKeyChainControllerGet().then(
            ({ data }) => data,
            () => undefined
          ),
        ]).then(([{ data }, defaultAccess]) => ({ data: { keyChains: data, defaultAccess } }))
      );
      promiseKeys.push('keyChains');
    }

    // Credential configs require issuance:manage
    if (this.jwtService.hasRole('issuance:manage')) {
      promises.push(credentialConfigControllerGetConfigs());
      promiseKeys.push('credentials');
      promises.push(issuanceConfigControllerGetIssuanceConfigurations());
      promiseKeys.push('issuance');
    }

    // Presentation configs require presentation:manage OR presentation:request
    if (this.canReadPresentationConfigs) {
      promises.push(presentationManagementControllerConfiguration());
      promiseKeys.push('presentations');
    }

    // Trust lists require presentation:manage
    if (this.canManagePresentation) {
      promises.push(trustListControllerGetAllTrustLists());
      promiseKeys.push('trustLists');
    }

    // Sessions require issuance:offer, presentation:request or sessions:read
    if (this.canViewSessions) {
      const allStats = sessionControllerGetSessionStats();
      promises.push(allStats);
      promiseKeys.push('sessionStats');
      promises.push(
        sessionControllerGetAllSessions({
          query: { pageSize: 5, sortBy: 'updatedAt', sortOrder: 'desc' },
        })
      );
      promiseKeys.push('recentSessions');
      // The window depends on the retention that comes with the counts.
      const window = allStats.then(({ data }) => activityWindow(data.retention));
      promises.push(
        window.then(async (activity) => ({
          data: { activity, buckets: await this.loadBucketStats(activity) },
        }))
      );
      promiseKeys.push('activity');
      // Carries the window too, so labels and links keep it when a bucket request fails.
      promises.push(
        window.then(async (activity) => {
          const { data } = await sessionControllerGetSessionStats({
            query: { createdFrom: activity.starts[0].toISOString() },
          });
          return { data: { activity, stats: data } };
        })
      );
      promiseKeys.push('window');
    }

    // KMS health requires the roles of key chains
    if (this.canManageKeyChains) {
      promises.push(keyChainControllerGetProvidersHealth());
      promiseKeys.push('kmsHealth');
    }

    if (this.canManageRegistrar) {
      promises.push(registrarControllerGetConfig());
      promiseKeys.push('registrar');
    }

    const results = await Promise.allSettled(promises);
    // A newer load has started; its results win.
    if (loadId !== this.loadId) return;

    this.reset();
    results.forEach((result, index) => {
      const key = promiseKeys[index];
      if (result.status === 'fulfilled') {
        try {
          this.apply(key, result.value.data);
        } catch (error) {
          // The response does not have the expected shape; treat it like a failed request.
          console.error(`Unexpected ${sourceLabels[key]} response for the dashboard:`, error);
          this.failedSources.set(key, { message: 'the response has an unexpected format' });
          return;
        }
      } else if (!(key === 'registrar' && hasHttpStatus(result.reason, 404))) {
        // The registrar answers 404 while it is not configured; anything else is a failure.
        console.error(`Failed to load ${sourceLabels[key]} for the dashboard:`, result.reason);
        this.failedSources.set(key, result.reason);
        return;
      }
      this.loadedSources.add(key);
    });
    this.lastUpdatedAt = new Date();
    this.isLoading = false;
  }

  /** At least one load has finished. */
  get hasLoaded(): boolean {
    return this.lastUpdatedAt !== null;
  }

  isLoaded(source: DashboardSource): boolean {
    return this.loadedSources.has(source);
  }

  hasFailed(source: DashboardSource): boolean {
    return this.failedSources.has(source);
  }

  // Role-based visibility helpers
  get canManageKeyChains(): boolean {
    return this.jwtService.hasRole(KEY_CHAIN_ROLES);
  }

  get canManageIssuance(): boolean {
    return this.jwtService.hasRole('issuance:manage');
  }

  get canManagePresentation(): boolean {
    return this.jwtService.hasRole('presentation:manage');
  }

  get canManageRegistrar(): boolean {
    return this.jwtService.hasRole('registrar:manage');
  }

  get isReadOnly(): boolean {
    return !this.canManageIssuance && !this.canManagePresentation;
  }

  get canOfferIssuance(): boolean {
    return this.jwtService.hasRole('issuance:offer');
  }

  get canViewSessions(): boolean {
    return this.jwtService.hasRole(SESSION_READER_ROLES);
  }

  get canReadPresentationConfigs(): boolean {
    return this.canManagePresentation || this.jwtService.hasRole('presentation:request');
  }

  get totalSessions(): number {
    return (this.sessionStats.issuance?.total ?? 0) + (this.sessionStats.presentation?.total ?? 0);
  }

  get sessionActive(): number {
    return this.countSessions('active');
  }

  get sessionFetched(): number {
    return this.countSessions('fetched');
  }

  get sessionCompleted(): number {
    return this.countSessions('completed');
  }

  get sessionExpired(): number {
    return this.countSessions('expired');
  }

  get sessionFailed(): number {
    return this.countSessions('failed');
  }

  get sessionCancelled(): number {
    return this.countSessions('cancelled');
  }

  get lastSuccessfulIssuanceAt(): string | null {
    return this.sessionStats.issuance?.lastCompletedAt ?? null;
  }

  get lastSuccessfulPresentationAt(): string | null {
    return this.sessionStats.presentation?.lastCompletedAt ?? null;
  }

  /** Sessions still waiting for the wallet, over all days; "pending" in the session list. */
  get pendingSessions(): number {
    return this.sessionActive + this.sessionFetched;
  }

  get activityBuckets(): ActivityBucket[] {
    return this.bucketStats.map(({ start, stats }) => {
      const types = [stats.issuance, stats.presentation].filter((type) => !!type);
      const sum = (read: (type: (typeof types)[number]) => number) =>
        types.reduce((total, type) => total + read(type), 0);
      const total = sum((type) => type.total);
      const completed = sum((type) => type.byStatus.completed);
      const failed = sum((type) => type.byStatus.failed);
      return { start, total, completed, failed, notCompleted: total - completed - failed };
    });
  }

  /** Sessions created in the current day or hour of the window. */
  get sessionsInCurrentBucket(): number {
    return this.activityBuckets.at(-1)?.total ?? 0;
  }

  private get windowTypes() {
    return [this.windowStats.issuance, this.windowStats.presentation].filter((type) => !!type);
  }

  private countInWindow(status: keyof SessionStatusCountsDto): number {
    return this.windowTypes.reduce((total, type) => total + type.byStatus[status], 0);
  }

  get sessionsInWindow(): number {
    return this.windowTypes.reduce((total, type) => total + type.total, 0);
  }

  get failedInWindow(): number {
    return this.countInWindow('failed');
  }

  /** Sessions of the window that reached completed, failed or expired. */
  get finishedInWindow(): number {
    return (
      this.countInWindow('completed') + this.countInWindow('failed') + this.countInWindow('expired')
    );
  }

  /** Completed share of the window's finished sessions, or null when none finished. */
  get successRate(): number | null {
    const finished = this.finishedInWindow;
    return finished === 0 ? null : this.countInWindow('completed') / finished;
  }

  /** The window's most frequent failure codes over both session types. */
  get topFailureCodes(): { code: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const type of this.windowTypes) {
      for (const { code, count } of type.failureCodes) {
        counts.set(code, (counts.get(code) ?? 0) + count);
      }
    }
    return [...counts]
      .map(([code, count]) => ({ code, count }))
      .sort((left, right) => right.count - left.count || left.code.localeCompare(right.code))
      .slice(0, TOP_FAILURE_CODES);
  }

  get unhealthyKmsProviders(): ProviderHealthResponseDto[] {
    return this.kmsProviders.filter((provider) => !provider.ok);
  }

  /** At least one health signal of the operational health card applies to the user. */
  get hasHealthSignals(): boolean {
    return (
      this.canManageKeyChains ||
      this.canManagePresentation ||
      this.canManageRegistrar ||
      !!this.sessionStats.issuance ||
      !!this.sessionStats.presentation
    );
  }

  // Prerequisites check - only relevant if user can manage key chains
  get hasPrerequisites(): boolean {
    return this.prerequisiteReason === null;
  }

  // Issuance readiness
  get isReadyToIssue(): boolean {
    if (!this.canManageIssuance) {
      return false; // User can't manage issuance
    }
    return this.issueReadinessReason === null;
  }

  // Verification readiness
  get isReadyToVerify(): boolean {
    if (!this.canReadPresentationConfigs) {
      return false; // User can't see presentation configs
    }
    return this.verifyReadinessReason === null;
  }

  // Overall setup complete (at least one path is ready)
  // Request-only access to presentations is not a setup the user completed
  private get isVerificationSetUp(): boolean {
    return this.canManagePresentation && this.isReadyToVerify;
  }

  get isSetupComplete(): boolean {
    return this.isReadyToIssue || this.isVerificationSetUp;
  }

  // Show setup guide if prerequisites are not met OR neither path is ready
  get showSetupGuide(): boolean {
    // A failed request would show steps as missing; the warning offers a retry instead.
    if (this.isReadOnly || this.setupSources.some((source) => this.hasFailed(source))) {
      return false;
    }

    return !this.hasPrerequisites || (!this.isReadyToIssue && !this.isVerificationSetUp);
  }

  get issueReadinessReason(): string | null {
    if (!this.canManageIssuance) {
      // The issuance form lists credential configs, which need issuance:manage.
      return this.canOfferIssuance
        ? 'The issuance form needs the issuance:manage role'
        : 'Read-only: missing issuance:manage role';
    }
    const prerequisite = this.prerequisiteReason;
    if (prerequisite) {
      return prerequisite;
    }
    if (this.hasFailed('issuance')) {
      return 'Issuer settings could not be loaded';
    }
    if (this.hasFailed('credentials')) {
      return 'Credential configs could not be loaded';
    }
    if (!this.hasIssuanceConfig) {
      return 'No issuer settings';
    }
    if (this.credentialConfigs === 0) {
      return 'No credential config';
    }
    return null;
  }

  get verifyReadinessReason(): string | null {
    if (!this.canReadPresentationConfigs) {
      return 'Read-only: missing presentation:manage or presentation:request role';
    }
    const prerequisite = this.prerequisiteReason;
    if (prerequisite) {
      return prerequisite;
    }
    if (this.hasFailed('presentations')) {
      return 'Presentation configs could not be loaded';
    }
    if (this.presentationConfigs === 0) {
      return this.canManagePresentation
        ? 'No presentation config'
        : 'No presentation config; ask a user with presentation:manage to create one';
    }
    return null;
  }

  // Key chains are only loaded for users who can manage them; not relevant otherwise.
  private get prerequisiteReason(): string | null {
    if (!this.canManageKeyChains) {
      return null;
    }
    if (this.hasFailed('keyChains')) {
      return 'Key chains could not be loaded';
    }
    if (this.totalKeyChains === 0) {
      return 'No key chain configured';
    }
    if (this.accessKeyChains === 0) {
      return 'No access key chain configured';
    }
    if (this.defaultAccessKeyChainMissing) {
      return 'The default access key chain no longer exists';
    }
    if (!this.hasActiveAccessCertificate) {
      return 'No access certificate configured';
    }
    if (!this.hasUsableAccessCertificate) {
      return 'Access certificate is expired';
    }
    return null;
  }

  /** The requests the setup guide relies on. */
  private get setupSources(): DashboardSource[] {
    const sources: DashboardSource[] = [];
    if (this.canManageKeyChains) sources.push('keyChains');
    if (this.canManageIssuance) sources.push('credentials', 'issuance');
    if (this.canManagePresentation) sources.push('presentations');
    return sources;
  }

  /**
   * Where to fix the access certificate: the affected key chain, the key list for a default
   * that no longer exists, or a new key chain.
   */
  get accessCertificateRoute(): string[] {
    if (this.accessKeyChainId) return ['/keys', this.accessKeyChainId];
    return this.defaultAccessKeyChainMissing ? ['/keys'] : ['/keys/create'];
  }

  get accessCertificateStatusLabel(): string {
    switch (this.accessCertificateStatus) {
      case 'healthy':
        return 'Healthy';
      case 'expiring':
        return 'Expiring soon';
      case 'expired':
        return 'Expired';
      default:
        return 'Missing';
    }
  }

  get warnings(): DashboardWarning[] {
    const warnings: DashboardWarning[] = [];
    const failures = [...this.failedSources]
      // Activity and window build on the session counts; their failure is the same one.
      .filter(([source]) => !(DERIVED_FROM_STATS.has(source) && this.hasFailed('sessionStats')))
      .map(([source, error]) => ({ label: sourceLabels[source], error }));
    // One warning for all requests the backend did not answer, so the hint appears once. It comes
    // first: an unreachable backend is the likeliest cause of the other failures too.
    const { unreachable, other } = groupUnreachable(
      failures,
      (labels) => `Could not load ${labels}`
    );
    if (unreachable) {
      warnings.push({ message: unreachable, retry: true });
    }
    for (const { label, error } of other) {
      const detail = apiErrorDetail(error);
      warnings.push({
        message: detail ? `Could not load ${label}: ${detail}` : `Could not load ${label}.`,
        retry: isRetryable(error),
      });
    }

    const certificateWarning = this.accessCertificateWarning;
    if (certificateWarning) {
      warnings.push(certificateWarning);
    }

    for (const provider of this.unhealthyKmsProviders) {
      const reason = provider.error ? `: ${provider.error}` : '.';
      warnings.push({
        message: `KMS provider ${provider.providerId} is not reachable${reason}`,
        action: { label: 'Open KMS Providers', route: ['/kms'] },
      });
    }

    if (this.canManagePresentation && this.isLoaded('trustLists') && !this.hasTrustList) {
      warnings.push({
        message: 'No trust list configured. Presentation trust-chain validation may fail.',
        action: { label: 'Add Trust List', route: ['/trust-list/create'] },
      });
    }

    if (this.canManageRegistrar && this.isLoaded('registrar') && !this.hasRegistrarConfig) {
      warnings.push({
        message:
          'Registrar is not configured. Access certificate enrollment via registrar is unavailable.',
        action: { label: 'Configure Registrar', route: ['/registrar'] },
      });
    }

    return warnings;
  }

  // A missing or expired certificate blocks the setup, so the setup guide shows it with a link.
  private get accessCertificateWarning(): DashboardWarning | null {
    // Key chains are only loaded for users who can manage them.
    if (!this.canManageKeyChains || !this.isLoaded('keyChains')) {
      return null;
    }
    if (this.accessCertificateStatus === 'expiring') {
      return {
        message: `Access certificate expires within ${this.accessCertificateExpiringSoonDays} days. Plan renewal to avoid interruptions.`,
        action: { label: 'Open Access Key Chain', route: this.accessCertificateRoute },
      };
    }
    return null;
  }

  get hasWarnings(): boolean {
    return this.warnings.length > 0;
  }

  private reset(): void {
    this.loadedSources.clear();
    this.failedSources.clear();
    this.sessionStats = {};
    this.totalKeyChains = 0;
    this.accessKeyChains = 0;
    this.accessKeyChainId = null;
    this.hasActiveAccessCertificate = false;
    this.hasUsableAccessCertificate = false;
    this.accessCertificateStatus = 'missing';
    this.defaultAccessKeyChainMissing = false;
    this.accessCertificateExpiresAt = null;
    this.accessCertificateDaysUntilExpiry = null;
    this.trustListCount = 0;
    this.hasTrustList = false;
    this.hasRegistrarConfig = false;
    this.credentialConfigs = 0;
    this.presentationConfigs = 0;
    this.hasIssuanceConfig = false;
    this.recentSessions = [];
    this.activity = null;
    this.bucketStats = [];
    this.windowStats = {};
    this.kmsProviders = [];
  }

  /** One stats request per bucket, so day boundaries follow the browser's time zone. */
  private loadBucketStats(activity: ActivityWindow): Promise<BucketStats[]> {
    return Promise.all(
      activity.starts.map(async (start) => {
        const next = new Date(start);
        if (activity.unit === 'day') next.setDate(next.getDate() + 1);
        else next.setHours(next.getHours() + 1);
        const { data } = await sessionControllerGetSessionStats({
          query: {
            createdFrom: start.toISOString(),
            createdTo: new Date(next.getTime() - 1).toISOString(),
          },
        });
        return { start, stats: data };
      })
    );
  }

  private apply(source: DashboardSource, data: any): void {
    switch (source) {
      case 'credentials':
        this.credentialConfigs = data.length;
        break;
      case 'presentations':
        this.presentationConfigs = data.length;
        break;
      case 'sessionStats':
        this.sessionStats = data;
        break;
      case 'recentSessions':
        this.recentSessions = data.items;
        break;
      case 'activity':
        this.activity = data.activity;
        this.bucketStats = data.buckets;
        break;
      case 'window':
        this.activity = data.activity;
        this.windowStats = data.stats;
        break;
      case 'kmsHealth':
        this.kmsProviders = data;
        break;
      case 'keyChains':
        this.totalKeyChains = data.keyChains.filter(
          (kc: KeyChainResponseDto) => kc.usageType !== 'encrypt'
        ).length;
        this.applyAccessCertificateHealth(
          data.keyChains.filter((kc: KeyChainResponseDto) => kc.usageType === 'access'),
          data.defaultAccess
        );
        break;
      case 'issuance':
        this.hasIssuanceConfig = !!data;
        break;
      case 'trustLists':
        this.trustListCount = data.length;
        this.hasTrustList = this.trustListCount > 0;
        break;
      case 'registrar':
        this.hasRegistrarConfig = !!data;
        break;
    }
  }

  /**
   * With a default access key chain set for the tenant, requests without their own access key
   * chain use only that one, so only its certificate counts.
   */
  private applyAccessCertificateHealth(
    accessKeyChains: KeyChainResponseDto[],
    defaultAccess?: DefaultAccessKeyChainDto
  ): void {
    this.accessKeyChains = accessKeyChains.length;
    const used = defaultAccess?.defaultAccessKeyChainId
      ? accessKeyChains.filter((kc) => kc.id === defaultAccess.keyChainId)
      : accessKeyChains;
    this.defaultAccessKeyChainMissing =
      !!defaultAccess?.defaultAccessKeyChainId && used.length === 0;
    this.accessKeyChainId = used[0]?.id ?? null;

    const now = Date.now();
    const withCertificate = used.filter((kc) => !!kc.activeCertificate?.pem);

    this.hasActiveAccessCertificate = withCertificate.length > 0;

    if (withCertificate.length === 0) {
      this.hasUsableAccessCertificate = false;
      this.accessCertificateStatus = 'missing';
      this.accessCertificateExpiresAt = null;
      this.accessCertificateDaysUntilExpiry = null;
      return;
    }

    let nearestValidExpiry: number | null = null;
    let hasNonExpired = false;

    for (const keyChain of withCertificate) {
      const notAfter = keyChain.activeCertificate?.notAfter;
      const expiryMs = notAfter ? Date.parse(notAfter) : Number.NaN;
      if (Number.isNaN(expiryMs)) {
        continue;
      }

      if (expiryMs > now) {
        hasNonExpired = true;
        if (nearestValidExpiry === null || expiryMs < nearestValidExpiry) {
          nearestValidExpiry = expiryMs;
          this.accessKeyChainId = keyChain.id;
        }
      }
    }

    this.hasUsableAccessCertificate = hasNonExpired;

    if (!hasNonExpired) {
      this.accessKeyChainId = withCertificate[0].id;
      this.accessCertificateStatus = 'expired';
      this.accessCertificateExpiresAt = null;
      this.accessCertificateDaysUntilExpiry = null;
      return;
    }

    this.accessCertificateExpiresAt =
      nearestValidExpiry !== null ? new Date(nearestValidExpiry).toISOString() : null;

    this.accessCertificateDaysUntilExpiry =
      nearestValidExpiry !== null
        ? Math.max(0, Math.ceil((nearestValidExpiry - now) / (24 * 60 * 60 * 1000)))
        : null;

    if (
      nearestValidExpiry !== null &&
      nearestValidExpiry - now <= this.accessCertificateExpiringSoonDays * 24 * 60 * 60 * 1000
    ) {
      this.accessCertificateStatus = 'expiring';
      return;
    }

    this.accessCertificateStatus = 'healthy';
  }

  private countSessions(status: keyof SessionStatusCountsDto): number {
    return (
      (this.sessionStats.issuance?.byStatus[status] ?? 0) +
      (this.sessionStats.presentation?.byStatus[status] ?? 0)
    );
  }
}
