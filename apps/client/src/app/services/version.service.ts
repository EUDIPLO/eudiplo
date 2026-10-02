import { Injectable } from '@angular/core';
import { appControllerGetVersion, type VersionResponseDto } from '@eudiplo/sdk-core';

export interface BuildInfo {
  version: string;
  revision?: string;
}

/**
 * - `match`: same build, or releases that only differ in the patch version
 * - `mismatch`: client and backend come from different builds
 * - `unknown`: not enough information to decide (e.g. local dev builds)
 */
export type VersionCompatibility = 'match' | 'mismatch' | 'unknown';

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/**
 * Decides whether the client can safely talk to the backend.
 * Both images are built from the same commit, so the git revision is the source of truth.
 * Released images only differing in the patch version are accepted as well.
 */
export function compareBuilds(client: BuildInfo, backend: BuildInfo): VersionCompatibility {
  if (client.revision && backend.revision && client.revision === backend.revision) {
    return 'match';
  }

  const clientSemver = SEMVER.exec(client.version);
  const backendSemver = SEMVER.exec(backend.version);
  if (
    clientSemver &&
    backendSemver &&
    !clientSemver[4] &&
    !backendSemver[4] &&
    clientSemver[1] === backendSemver[1] &&
    clientSemver[2] === backendSemver[2]
  ) {
    return 'match';
  }

  if ((client.revision && backend.revision) || (clientSemver && backendSemver)) {
    return 'mismatch';
  }
  return 'unknown';
}

/**
 * Compares the client build with the build of the connected backend.
 */
@Injectable({ providedIn: 'root' })
export class VersionService {
  readonly client: BuildInfo = readClientBuildInfo();
  backend: BuildInfo | null = null;
  compatibility: VersionCompatibility = 'unknown';
  dismissed = false;

  private checkedBaseUrl?: string;
  private pending?: Promise<void>;

  /**
   * Fetches the backend version once per backend URL. Requires an authenticated session.
   */
  check(baseUrl: string | undefined): Promise<void> {
    if (this.checkedBaseUrl === baseUrl) {
      return this.pending ?? Promise.resolve();
    }
    this.checkedBaseUrl = baseUrl;
    this.backend = null;
    this.compatibility = 'unknown';
    this.dismissed = false;

    this.pending = appControllerGetVersion()
      .then((response) => {
        const data = response.data as VersionResponseDto | undefined;
        if (data?.version) {
          this.backend = { version: data.version, revision: data.revision || undefined };
          this.compatibility = compareBuilds(this.client, this.backend);
        }
      })
      .catch((error) => {
        console.error('Failed to fetch backend version:', error);
        this.checkedBaseUrl = undefined;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }

  get showWarning(): boolean {
    return this.compatibility === 'mismatch' && !this.dismissed;
  }

  dismiss(): void {
    this.dismissed = true;
  }
}

function readClientBuildInfo(): BuildInfo {
  const env = (window as any)['env'];
  return {
    version: env?.version || 'dev',
    revision: env?.revision || undefined,
  };
}
