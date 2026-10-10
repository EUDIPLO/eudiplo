import { Injectable } from '@angular/core';
import {
  credentialConfigControllerGetConfigs,
  presentationManagementControllerConfiguration,
  sessionControllerGetAllSessions,
  sessionControllerGetSessionStats,
  keyChainControllerGetAll,
  issuanceConfigControllerGetIssuanceConfigurations,
  registrarControllerGetConfig,
  trustListControllerGetAllTrustLists,
  KeyChainResponseDto,
  Session,
  SessionStatsResponseDto,
  SessionStatusCountsDto,
} from '@eudiplo/sdk-core';
import { JwtService } from '../services/jwt.service';

type AccessCertificateStatus = 'missing' | 'expired' | 'expiring' | 'healthy';

@Injectable({
  providedIn: 'root',
})
export class DashboardService {
  private readonly accessCertificateExpiringSoonDays = 30;

  credentialConfigs = 0;
  presentationConfigs = 0;
  /** Only holds the session types the user may read. */
  sessionStats: SessionStatsResponseDto = {};
  /** False until the session counts arrive, and when their request fails. */
  sessionStatsLoaded = false;
  totalKeyChains = 0;
  accessKeyChains = 0;
  hasActiveAccessCertificate = false;
  hasUsableAccessCertificate = false;
  accessCertificateStatus: AccessCertificateStatus = 'missing';
  accessCertificateExpiresAt: string | null = null;
  accessCertificateDaysUntilExpiry: number | null = null;
  trustListCount = 0;
  hasTrustList = false;
  hasRegistrarConfig = false;
  hasIssuanceConfig = false;
  recentSessions: Session[] = [];
  recentSessionsLoaded = false;
  isLoading = true;

  constructor(private readonly jwtService: JwtService) {}

  async getCounters(): Promise<void> {
    this.isLoading = true;
    // Reset counters
    this.sessionStats = {};
    this.sessionStatsLoaded = false;
    this.totalKeyChains = 0;
    this.accessKeyChains = 0;
    this.hasActiveAccessCertificate = false;
    this.hasUsableAccessCertificate = false;
    this.accessCertificateStatus = 'missing';
    this.accessCertificateExpiresAt = null;
    this.accessCertificateDaysUntilExpiry = null;
    this.trustListCount = 0;
    this.hasTrustList = false;
    this.hasRegistrarConfig = false;
    this.credentialConfigs = 0;
    this.presentationConfigs = 0;
    this.hasIssuanceConfig = false;
    this.recentSessions = [];
    this.recentSessionsLoaded = false;

    try {
      // Build list of promises based on user roles
      const promises: Promise<any>[] = [];
      const promiseKeys: string[] = [];

      if (this.canManageKeyChains) {
        promises.push(keyChainControllerGetAll());
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

      // Sessions require issuance:offer OR presentation:request
      if (this.canViewSessions) {
        promises.push(sessionControllerGetSessionStats());
        promiseKeys.push('sessionStats');
        promises.push(
          sessionControllerGetAllSessions({
            query: { pageSize: 5, sortBy: 'updatedAt', sortOrder: 'desc' },
          })
        );
        promiseKeys.push('recentSessions');
      }

      if (this.canManageRegistrar) {
        promises.push(registrarControllerGetConfig());
        promiseKeys.push('registrar');
      }

      const results = await Promise.allSettled(promises);

      // Process results based on their keys
      results.forEach((result, index) => {
        const key = promiseKeys[index];
        if (result.status === 'fulfilled') {
          switch (key) {
            case 'credentials':
              this.credentialConfigs = result.value.data.length;
              break;
            case 'presentations':
              this.presentationConfigs = result.value.data.length;
              break;
            case 'sessionStats':
              this.sessionStats = result.value.data;
              this.sessionStatsLoaded = true;
              break;
            case 'recentSessions':
              this.recentSessions = result.value.data.items;
              this.recentSessionsLoaded = true;
              break;
            case 'keyChains': {
              this.totalKeyChains = result.value.data.filter(
                (kc: { usageType: string }) => kc.usageType !== 'encrypt'
              ).length;

              const accessKeyChains = result.value.data.filter(
                (kc: { usageType: string }) => kc.usageType === 'access'
              );
              this.applyAccessCertificateHealth(accessKeyChains);
              break;
            }
            case 'issuance':
              this.hasIssuanceConfig = !!result.value.data;
              break;
            case 'trustLists':
              this.trustListCount = result.value.data.length;
              this.hasTrustList = this.trustListCount > 0;
              break;
            case 'registrar':
              this.hasRegistrarConfig = !!result.value.data;
              break;
          }
        } else if (key === 'registrar') {
          this.hasRegistrarConfig = false;
        }
      });
    } catch (error) {
      console.error('Failed to fetch dashboard stats:', error);
    } finally {
      this.isLoading = false;
    }
  }

  // Role-based visibility helpers
  // Key chains require issuance:manage OR presentation:manage
  get canManageKeyChains(): boolean {
    return this.jwtService.hasRole(['issuance:manage', 'presentation:manage']);
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

  get canViewSessions(): boolean {
    return (
      this.jwtService.hasRole('issuance:offer') || this.jwtService.hasRole('presentation:request')
    );
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
    return this.hasPrerequisites && this.hasIssuanceConfig && this.credentialConfigs > 0;
  }

  // Verification readiness
  get isReadyToVerify(): boolean {
    if (!this.canReadPresentationConfigs) {
      return false; // User can't see presentation configs
    }
    return this.hasPrerequisites && this.presentationConfigs > 0;
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
    if (this.isReadOnly) {
      return false;
    }

    return !this.hasPrerequisites || (!this.isReadyToIssue && !this.isVerificationSetUp);
  }

  get issueReadinessReason(): string | null {
    if (!this.canManageIssuance) {
      return 'Read-only: missing issuance:manage role';
    }
    const prerequisite = this.prerequisiteReason;
    if (prerequisite) {
      return prerequisite;
    }
    if (!this.hasIssuanceConfig) {
      return 'No issuance config';
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
    if (this.totalKeyChains === 0) {
      return 'No key chain configured';
    }
    if (this.accessKeyChains === 0) {
      return 'No access key chain configured';
    }
    if (!this.hasActiveAccessCertificate) {
      return 'No access certificate configured';
    }
    if (!this.hasUsableAccessCertificate) {
      return 'Access certificate is expired';
    }
    return null;
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

  get accessCertificateStatusColor(): 'primary' | 'accent' | 'warn' {
    switch (this.accessCertificateStatus) {
      case 'healthy':
        return 'primary';
      case 'expiring':
        return 'accent';
      case 'expired':
      case 'missing':
      default:
        return 'warn';
    }
  }

  get warningMessages(): string[] {
    const warnings: string[] = [];
    const certificateWarning = this.accessCertificateWarning;
    if (certificateWarning) {
      warnings.push(certificateWarning);
    }

    if (this.canManagePresentation && !this.hasTrustList) {
      warnings.push('No trust list configured. Presentation trust-chain validation may fail.');
    }

    if (this.canManageRegistrar && !this.hasRegistrarConfig) {
      warnings.push(
        'Registrar is not configured. Access certificate enrollment via registrar is unavailable.'
      );
    }

    if (this.canViewSessions && this.sessionStatsLoaded && this.totalSessions === 0) {
      warnings.push(
        'No sessions recorded yet. Run an issuance or presentation flow to validate end-to-end setup.'
      );
    }

    return warnings;
  }

  private get accessCertificateWarning(): string | null {
    // Key chains are only loaded for users who can manage them.
    if (!this.canManageKeyChains) {
      return null;
    }
    if (!this.hasActiveAccessCertificate) {
      return 'No access certificate configured. Issuance and presentation flows cannot start.';
    }
    if (!this.hasUsableAccessCertificate) {
      return 'Access certificate is expired. Renew it before issuing or requesting presentations.';
    }
    if (this.accessCertificateStatus === 'expiring') {
      return `Access certificate expires within ${this.accessCertificateExpiringSoonDays} days. Plan renewal to avoid interruptions.`;
    }
    return null;
  }

  get hasWarnings(): boolean {
    return this.warningMessages.length > 0;
  }

  get setupProgress(): number {
    const weights = {
      keyChain: 20,
      accessCertificate: 35,
      issuancePath: this.canManageIssuance ? 25 : 0,
      presentationPath: this.canManagePresentation ? 20 : 0,
    };

    const totalWeight =
      weights.keyChain +
      weights.accessCertificate +
      weights.issuancePath +
      weights.presentationPath;

    if (totalWeight === 0) {
      return 100;
    }

    let achieved = 0;
    if (this.totalKeyChains > 0) achieved += weights.keyChain;
    if (this.hasUsableAccessCertificate) achieved += weights.accessCertificate;
    if (this.hasIssuanceConfig && this.credentialConfigs > 0) achieved += weights.issuancePath;
    if (this.presentationConfigs > 0) achieved += weights.presentationPath;

    return Math.round((achieved / totalWeight) * 100);
  }

  private applyAccessCertificateHealth(accessKeyChains: KeyChainResponseDto[]): void {
    this.accessKeyChains = accessKeyChains.length;

    const now = Date.now();
    const certs = accessKeyChains
      .map((kc) => kc.activeCertificate)
      .filter((cert): cert is NonNullable<KeyChainResponseDto['activeCertificate']> => !!cert?.pem);

    this.hasActiveAccessCertificate = certs.length > 0;

    if (certs.length === 0) {
      this.hasUsableAccessCertificate = false;
      this.accessCertificateStatus = 'missing';
      this.accessCertificateExpiresAt = null;
      this.accessCertificateDaysUntilExpiry = null;
      return;
    }

    let nearestValidExpiry: number | null = null;
    let hasNonExpired = false;

    for (const cert of certs) {
      const expiryMs = cert.notAfter ? Date.parse(cert.notAfter) : Number.NaN;
      if (Number.isNaN(expiryMs)) {
        continue;
      }

      if (expiryMs > now) {
        hasNonExpired = true;
        if (nearestValidExpiry === null || expiryMs < nearestValidExpiry) {
          nearestValidExpiry = expiryMs;
        }
      }
    }

    this.hasUsableAccessCertificate = hasNonExpired;

    if (!hasNonExpired) {
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
