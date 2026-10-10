import { Injectable } from '@angular/core';
import {
  keyChainControllerGetAll,
  KeyChainResponseDto,
  presentationManagementControllerGetConfiguration,
  PresentationRequest,
  presentationManagementControllerConfiguration,
  presentationManagementControllerDeleteConfiguration,
  presentationManagementControllerStorePresentationConfig,
  verifierOfferControllerGetOffer,
  PresentationConfigCreateDto,
} from '@eudiplo/sdk-core';
import { JwtService } from '../../services/jwt.service';

@Injectable({
  providedIn: 'root',
})
export class PresentationManagementService {
  constructor(private readonly jwtService: JwtService) {}

  createConfiguration(value: PresentationConfigCreateDto) {
    return presentationManagementControllerStorePresentationConfig({ body: value }).then(
      (response) => response.data
    );
  }
  getPresentationById(presentationId: string) {
    return presentationManagementControllerGetConfiguration({ path: { id: presentationId } }).then(
      (response) => response.data
    );
  }
  loadConfigurations() {
    return presentationManagementControllerConfiguration().then((response) => {
      return response.data || [];
    });
  }

  deleteConfiguration(id: string) {
    return presentationManagementControllerDeleteConfiguration({
      path: { id },
    });
  }

  getOffer(offerRequest: PresentationRequest) {
    return verifierOfferControllerGetOffer({ body: offerRequest }).then(
      (response) => response.data
    );
  }

  async checkPresentationReadiness(requestId: string): Promise<{
    ready: boolean;
    reason?: string;
  }> {
    const config = await this.getPresentationById(requestId);
    if (!config) {
      return {
        ready: false,
        reason: 'Presentation configuration not found',
      };
    }

    // Reading key chains needs a manage role. Without one, the backend checks
    // the access certificate when the request is created.
    if (!this.jwtService.hasRole(['issuance:manage', 'presentation:manage'])) {
      return { ready: true };
    }

    const keyChainsResponse = await keyChainControllerGetAll({});
    const accessKeyChains = (keyChainsResponse.data || []).filter(
      (keyChain: KeyChainResponseDto) => keyChain.usageType === 'access'
    );

    if (accessKeyChains.length === 0) {
      return {
        ready: false,
        reason:
          'No access key chain is configured. Create an access key chain and access certificate first.',
      };
    }

    const hasActiveCertificate = (keyChain: KeyChainResponseDto): boolean =>
      !!keyChain.activeCertificate?.pem;

    if (config.accessKeyChainId) {
      const selectedKeyChain = accessKeyChains.find(
        (keyChain) => keyChain.id === config.accessKeyChainId
      );
      if (!selectedKeyChain) {
        return {
          ready: false,
          reason: 'The selected access key chain for this presentation config does not exist.',
        };
      }

      if (!hasActiveCertificate(selectedKeyChain)) {
        return {
          ready: false,
          reason:
            'The selected access key chain has no active access certificate. Create or refresh the access certificate first.',
        };
      }

      return { ready: true };
    }

    if (!accessKeyChains.some(hasActiveCertificate)) {
      return {
        ready: false,
        reason:
          'No active access certificate is available for any access key chain. Create an access certificate first.',
      };
    }

    return { ready: true };
  }
}
