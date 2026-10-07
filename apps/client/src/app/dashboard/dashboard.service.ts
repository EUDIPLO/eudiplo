import { Injectable } from '@angular/core';
import {
  credentialConfigControllerGetConfigs,
  presentationManagementControllerConfiguration,
  sessionControllerGetAllSessions,
  keyChainControllerGetAll,
  issuanceConfigControllerGetIssuanceConfigurations,
  registrarControllerGetConfig,
  trustListControllerGetAllTrustLists,
  KeyChainResponseDto,
  Session,
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
  sessionActive = 0;
  sessionCompleted = 0;
  sessionFetched = 0;
  sessionFailed = 0;
  sessionExpired = 0;
  sessionCancelled = 0;
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
  lastSuccessfulIssuanceAt: string | null = null;
  lastSuccessfulPresentationAt: string | null = null;
  hasIssuanceConfig = false;
  recentSessions: Session[] = [];
  isLoading = true;

  constructor(private readonly jwtService: JwtService) {}

  async getCounters(): Promise<void> {
    this.isLoading = true;
    // Reset counters
    this.sessionActive = 0;
    this.sessionCompleted = 0;
    this.sessionFetched = 0;
    this.sessionFailed = 0;
    this.sessionExpired = 0;
    this.sessionCancelled = 0;
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
    this.lastSuccessfulIssuanceAt = null;
    this.lastSuccessfulPresentationAt = null;
    this.credentialConfigs = 0;
    this.presentationConfigs = 0;
    this.hasIssuanceConfig = false;
    this.recentSessions = [];

    try {
      // Build list of promises based on user roles
      const promises: Promise<any>[] = [];
      const promiseKeys: string[] = [];

      // Key chains require issuance:manage OR presentation:manage
      const canManageKeyChains =
        this.jwtService.hasRole('issuance:manage') ||
        this.jwtService.hasRole('presentation:manage');

      if (canManageKeyChains) {
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

      // Presentation configs require presentation:manage
      if (this.jwtService.hasRole('presentation:manage')) {
        promises.push(presentationManagementControllerConfiguration());
        promiseKeys.push('presentations');

        promises.push(trustListControllerGetAllTrustLists());
        promiseKeys.push('trustLists');
      }

      // Sessions require issuance:offer OR presentation:request
      if (
        this.jwtService.hasRole('issuance:offer') ||
        this.jwtService.hasRole('presentation:request')
      ) {
        promises.push(sessionControllerGetAllSessions());
        promiseKeys.push('sessions');
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
            case 'sessions':
              this.recentSessions = [...result.value.data.items]
                .sort(
                  (left: Session, right: Session) =>
                    new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
                )
                .slice(0, 5);
              result.value.data.items.forEach((session: Session) => {
                switch (session.status) {
                  case 'active':
                    this.sessionActive++;
                    break;
                  case 'completed':
                    this.sessionCompleted++;
                    break;
                  case 'fetched':
                    this.sessionFetched++;
                    break;
                  case 'failed':
                    this.sessionFailed++;
                    break;
                  case 'expired':
                    this.sessionExpired++;
                    break;
                  case 'cancelled':
                    this.sessionCancelled++;
                    break;
                }

                if (session.status === 'completed') {
                  this.captureLastSuccessfulFlowTimestamp(session);
                }
              });
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
  get canManageKeyChains(): boolean {
    return (
      this.jwtService.hasRole('issuance:manage') || this.jwtService.hasRole('presentation:manage')
    );
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

  get totalSessions(): number {
    return (
      this.sessionActive +
      this.sessionCompleted +
      this.sessionFetched +
      this.sessionFailed +
      this.sessionExpired
    );
  }

  // Prerequisites check - only relevant if user can manage key chains
  get hasPrerequisites(): boolean {
    if (!this.canManageKeyChains) {
      return true; // Not relevant for this user
    }
    return this.totalKeyChains > 0 && this.accessKeyChains > 0 && this.hasUsableAccessCertificate;
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
    if (!this.canManagePresentation) {
      return false; // User can't manage presentations
    }
    return this.hasPrerequisites && this.presentationConfigs > 0;
  }

  // Overall setup complete (at least one path is ready)
  get isSetupComplete(): boolean {
    return this.isReadyToIssue || this.isReadyToVerify;
  }

  // Show setup guide if prerequisites are not met OR neither path is ready
  get showSetupGuide(): boolean {
    if (this.isReadOnly) {
      return false;
    }

    return !this.hasPrerequisites || (!this.isReadyToIssue && !this.isReadyToVerify);
  }

  get issueReadinessReason(): string | null {
    if (!this.canManageIssuance) {
      return 'Read-only: missing issuance:manage role';
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
    if (!this.hasIssuanceConfig) {
      return 'No issuance config';
    }
    if (this.credentialConfigs === 0) {
      return 'No credential config';
    }
    return null;
  }

  get verifyReadinessReason(): string | null {
    if (!this.canManagePresentation) {
      return 'Read-only: missing presentation:manage role';
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
    if (this.presentationConfigs === 0) {
      return 'No presentation config';
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
    if (!this.hasActiveAccessCertificate) {
      warnings.push(
        'No access certificate configured. Issuance and presentation flows cannot start.'
      );
    } else if (!this.hasUsableAccessCertificate) {
      warnings.push(
        'Access certificate is expired. Renew it before issuing or requesting presentations.'
      );
    } else if (this.accessCertificateStatus === 'expiring') {
      warnings.push(
        `Access certificate expires within ${this.accessCertificateExpiringSoonDays} days. Plan renewal to avoid interruptions.`
      );
    }

    if (this.canManagePresentation && !this.hasTrustList) {
      warnings.push('No trust list configured. Presentation trust-chain validation may fail.');
    }

    if (this.canManageRegistrar && !this.hasRegistrarConfig) {
      warnings.push(
        'Registrar is not configured. Access certificate enrollment via registrar is unavailable.'
      );
    }

    if (
      this.canViewSessions &&
      this.sessionActive +
        this.sessionCompleted +
        this.sessionFetched +
        this.sessionFailed +
        this.sessionExpired ===
        0
    ) {
      warnings.push(
        'No sessions recorded yet. Run an issuance or presentation flow to validate end-to-end setup.'
      );
    }

    return warnings;
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

  private captureLastSuccessfulFlowTimestamp(session: Session): void {
    const timestamp = session.updatedAt || session.createdAt;
    if (!timestamp) {
      return;
    }

    if (this.isPresentationSession(session)) {
      this.lastSuccessfulPresentationAt = this.maxIso(this.lastSuccessfulPresentationAt, timestamp);
      return;
    }

    if (this.isIssuanceSession(session)) {
      this.lastSuccessfulIssuanceAt = this.maxIso(this.lastSuccessfulIssuanceAt, timestamp);
    }
  }

  private isPresentationSession(session: Session): boolean {
    return !!session.requestUrl || !!session.requestObject || !!session.vp_nonce;
  }

  private isIssuanceSession(session: Session): boolean {
    return !!session.credentialPayload || !!session.offerUrl;
  }

  private maxIso(current: string | null, incoming: string): string {
    if (!current) {
      return incoming;
    }

    return Date.parse(incoming) > Date.parse(current) ? incoming : current;
  }
}
