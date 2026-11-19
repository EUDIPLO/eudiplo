import { inject, Injectable } from '@angular/core';
import type { PresentationConfig } from '@eudiplo/sdk-core';
import { IssuanceConfigService } from '../issuance/issuance-config/issuance-config.service';
import { PresentationManagementService } from '../presentation/presentation-config/presentation-management.service';
import { JwtService } from '../services/jwt.service';
import {
  issuanceConfigNamesTrustAnchor,
  presentationConfigNamesTrustAnchor,
} from './federation-trust-anchor-reference';

/** What a page knows about the configurations of one kind that name the trust anchor. */
export interface References<T> {
  loading: boolean;
  failed: boolean;
  /** The configurations that name it; for the one issuance configuration, a flag. */
  found: T;
}

/**
 * The configurations that name a trust anchor's entity ID, as far as the caller's roles can
 * read them. Provided per page, which shows them or names them before a delete or entity ID
 * change that the backend refuses while they name it.
 */
@Injectable()
export class FederationTrustAnchorReferences {
  private readonly issuanceConfigService = inject(IssuanceConfigService);
  private readonly presentationService = inject(PresentationManagementService);
  private readonly jwtService = inject(JwtService);

  readonly issuance: References<boolean> = { loading: false, failed: false, found: false };
  readonly presentations: References<PresentationConfig[]> = {
    loading: false,
    failed: false,
    found: [],
  };

  /** The issuance configuration, and so its trust anchors, needs `issuance:manage`. */
  get canReadIssuanceConfig(): boolean {
    return this.jwtService.hasRole('issuance:manage');
  }

  /** Presentation configurations need `presentation:manage` here, as on their own page. */
  get canReadPresentationConfigs(): boolean {
    return this.jwtService.hasRole('presentation:manage');
  }

  /** True while a lookup runs, so a question about the references would be incomplete. */
  get loading(): boolean {
    return this.issuance.loading || this.presentations.loading;
  }

  async load(entityId: string): Promise<void> {
    await Promise.all([this.loadIssuance(entityId), this.loadPresentations(entityId)]);
  }

  /**
   * The configurations found, as a sentence names them, such as "the issuance configuration
   * and 2 verification configs"; empty when none were found.
   */
  describe(): string {
    const uses: string[] = [];
    if (this.issuance.found) uses.push('the issuance configuration');
    const count = this.presentations.found.length;
    if (count) uses.push(`${count} verification config${count === 1 ? '' : 's'}`);
    return uses.join(' and ');
  }

  private async loadIssuance(entityId: string): Promise<void> {
    if (!this.canReadIssuanceConfig) return;
    this.issuance.loading = true;
    this.issuance.failed = false;
    try {
      const config = await this.issuanceConfigService.getConfig();
      this.issuance.found = issuanceConfigNamesTrustAnchor(config, entityId);
    } catch {
      this.issuance.failed = true;
    } finally {
      this.issuance.loading = false;
    }
  }

  private async loadPresentations(entityId: string): Promise<void> {
    if (!this.canReadPresentationConfigs) return;
    this.presentations.loading = true;
    this.presentations.failed = false;
    try {
      const configs = await this.presentationService.loadConfigurations();
      this.presentations.found = configs.filter((config) =>
        presentationConfigNamesTrustAnchor(config, entityId)
      );
    } catch {
      this.presentations.failed = true;
    } finally {
      this.presentations.loading = false;
    }
  }
}
