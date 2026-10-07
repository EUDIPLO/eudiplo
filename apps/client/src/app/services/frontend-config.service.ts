import { inject, Injectable } from '@angular/core';
import { appControllerGetFrontendConfig, type FrontendConfigResponseDto } from '@eudiplo/sdk-core';
import { ApiService } from '../core';

export type ConfigImportMode = 'disabled' | 'create' | 'upsert' | 'replace';

export interface FrontendConfig {
  configImportMode: ConfigImportMode;
  /** The backend's `PUBLIC_URL`; missing when the backend does not report it. */
  publicUrl?: string;
}

@Injectable({ providedIn: 'root' })
export class FrontendConfigService {
  private readonly apiService = inject(ApiService);
  private config: FrontendConfig | null = null;
  /** Instance URL the cached config belongs to; signing in to another instance reloads it. */
  private configBaseUrl?: string;
  private configPromise: Promise<FrontendConfig | null> | null = null;

  async getConfig(): Promise<FrontendConfig | null> {
    const baseUrl = this.apiService.getBaseUrl();
    if (this.config && this.configBaseUrl === baseUrl) return this.config;
    if (this.configPromise !== null) return this.configPromise;

    this.configPromise = appControllerGetFrontendConfig()
      .then((response) => {
        const data = response.data as FrontendConfigResponseDto | undefined;
        this.config = data?.configImportMode
          ? { configImportMode: data.configImportMode, publicUrl: data.publicUrl || undefined }
          : null;
        this.configBaseUrl = baseUrl;
        return this.config;
      })
      .catch(() => null)
      .finally(() => {
        this.configPromise = null;
      });

    return this.configPromise;
  }

  get configImportMode(): ConfigImportMode | null {
    return this.config?.configImportMode ?? null;
  }
}
