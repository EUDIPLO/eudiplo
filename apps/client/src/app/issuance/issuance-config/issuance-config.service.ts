import { Injectable } from '@angular/core';
import {
  type IssuanceConfig,
  issuanceConfigControllerGetIssuanceConfigurations,
  issuanceConfigControllerStoreIssuanceConfiguration,
  credentialOfferControllerGetOffer,
  type OfferRequestDto,
  UpdateIssuanceDto,
} from '@eudiplo/sdk-core';

/**
 * Access token lifetime (seconds) applied when an authorization server has no
 * `token.lifetimeSeconds`. The built-in AS issues short-lived (FAPI-style) access tokens.
 */
export function defaultAccessTokenLifetimeSeconds(type: string | undefined): number {
  return type === 'built-in' ? 300 : 3600;
}

/** How the status list of a presented wallet attestation is checked. */
export type WalletAttestationStatusCheckMode = NonNullable<
  IssuanceConfig['walletAttestationStatusCheckMode']
>;

/** An authorization server's status check mode for the API: `inherit` is sent as unset. */
export function statusCheckModeOverride(
  value: WalletAttestationStatusCheckMode | 'inherit' | null | undefined
): WalletAttestationStatusCheckMode | undefined {
  return value && value !== 'inherit' ? value : undefined;
}

/** Display text of the status check mode that applies; unset applies best effort. */
export function statusCheckModeLabel(
  value: WalletAttestationStatusCheckMode | null | undefined
): string {
  switch (value) {
    case 'strict':
      return 'Strict';
    case 'disabled':
      return 'Disabled';
    default:
      return 'Best effort';
  }
}

@Injectable({
  providedIn: 'root',
})
export class IssuanceConfigService {
  getConfig() {
    return issuanceConfigControllerGetIssuanceConfigurations().then((response) => response.data);
  }

  /**
   * Save or update an issuance configuration
   */
  saveConfiguration(config: UpdateIssuanceDto) {
    return issuanceConfigControllerStoreIssuanceConfiguration({ body: config }).then(
      (response) => response.data
    );
  }

  getOffer(values: OfferRequestDto) {
    return credentialOfferControllerGetOffer({ body: values }).then((response) => response.data);
  }
}
