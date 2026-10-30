import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { provideRouter } from '@angular/router';

import { ApiService } from '../../core';
import { OidcService } from '../../core/oidc.service';
import type { ConfigImportMode } from '../../services/frontend-config.service';
import { FrontendConfigService } from '../../services/frontend-config.service';
import { VersionService } from '../../services/version.service';
import { ConnectionSettingsComponent } from './connection-settings.component';

describe('ConnectionSettingsComponent', () => {
  let version: Partial<VersionService>;
  /** What the frontend config request returns; null when it fails. */
  let importMode: ConfigImportMode | null;
  /** The secret the signed-in tab holds; undefined after a reload. */
  let secret: string | undefined;
  let rejected: boolean;
  let oidcMode: 'local' | 'oidc';
  let fixture: ComponentFixture<ConnectionSettingsComponent>;

  async function render(): Promise<HTMLElement> {
    const frontendConfig = {
      configImportMode: null as ConfigImportMode | null,
      getConfig: async () => {
        frontendConfig.configImportMode = importMode;
        return importMode ? { configImportMode: importMode } : null;
      },
    };
    TestBed.configureTestingModule({
      imports: [ConnectionSettingsComponent],
      providers: [
        provideRouter([]),
        {
          provide: ApiService,
          useValue: {
            getBaseUrl: () => 'http://localhost:3000',
            getClientId: () => 'demo',
            getClientSecret: () => secret,
            getoidcUrl: () => undefined,
            canRefreshToken: () => oidcMode === 'oidc' || !!secret,
            areCredentialsRejected: () => rejected,
          },
        },
        { provide: OidcService, useValue: { mode: oidcMode } },
        { provide: VersionService, useValue: version },
        { provide: FrontendConfigService, useValue: frontendConfig },
      ],
    });
    fixture = TestBed.createComponent(ConnectionSettingsComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  const value = (page: HTMLElement, label: string) =>
    (page.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement).value;

  beforeEach(() => {
    importMode = 'disabled';
    secret = undefined;
    rejected = false;
    oidcMode = 'local';
    version = {
      check: () => Promise.resolve(),
      client: { version: '10.0.0', revision: 'abcdef0123' },
      backend: { version: '10.0.0', revision: 'abcdef0123' },
      compatibility: 'match',
    };
  });

  it('loads and shows the versions and the configuration import mode', async () => {
    const page = await render();

    expect(value(page, 'Backend version')).toBe('10.0.0 (commit abcdef0)');
    expect(value(page, 'Client version')).toBe('10.0.0 (commit abcdef0)');
    expect(value(page, 'Startup configuration import mode')).toBe('disabled');
    expect(page.textContent).not.toContain('different builds');
  });

  it('says that a session without the client secret is not renewed and offers nothing to copy', async () => {
    const page = await render();

    expect(value(page, 'Client Secret')).toBe('Not available in this tab');
    expect(page.querySelector('input[aria-label="Client Secret"]')?.getAttribute('type')).not.toBe(
      'password'
    );
    expect(page.querySelector('[aria-label="Copy Client Secret to clipboard"]')).toBeNull();
    expect(page.textContent).toContain(
      'Automatic token refresh: disabled. The Web Client keeps the client secret only until the page reloads'
    );
  });

  it('shows the secret of the tab that signed in, which renews its token', async () => {
    secret = 'demo-secret';

    const page = await render();

    expect(value(page, 'Client Secret')).toBe('demo-secret');
    expect(page.querySelector('input[aria-label="Client Secret"]')?.getAttribute('type')).toBe(
      'password'
    );
    expect(
      page.querySelector(
        '.mat-mdc-form-field-icon-suffix [aria-label="Copy Client Secret to clipboard"]'
      )
    ).not.toBeNull();
    expect(page.textContent).toContain('Automatic token refresh: enabled');
    expect(page.textContent).not.toContain('keeps the client secret only until');
  });

  it('says why a session whose credentials were rejected is not renewed', async () => {
    rejected = true;

    const page = await render();

    expect(page.textContent).toContain(
      'Automatic token refresh: disabled. The token endpoint rejected the credentials; log in again.'
    );
    expect(page.textContent).not.toContain('keeps the client secret only until');
  });

  it('says that SSO uses no client secret', async () => {
    oidcMode = 'oidc';

    const page = await render();

    expect(value(page, 'Client Secret')).toBe('Not used with SSO');
    expect(page.textContent).toContain('Automatic token refresh: enabled');
  });

  it('says when client and backend come from different builds', async () => {
    version.backend = { version: '9.1.0' };
    version.compatibility = 'mismatch';

    const page = await render();

    expect(value(page, 'Backend version')).toBe('9.1.0');
    expect(page.querySelector('.hint-row.warning')?.textContent).toContain(
      'Use the client image with the same tag as the backend.'
    );
  });

  it('says a value is unavailable once its request has failed', async () => {
    version.backend = null;
    importMode = null;

    const page = await render();

    expect(value(page, 'Backend version')).toBe('Unavailable');
    expect(value(page, 'Startup configuration import mode')).toBe('Unavailable');
  });

  describe('when the browser cannot copy', () => {
    beforeEach(() => {
      Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    });
    afterEach(() => {
      delete (navigator as { clipboard?: Clipboard }).clipboard;
    });

    it('says to copy a shown value by hand', async () => {
      const page = await render();
      const open = vi.spyOn(fixture.debugElement.injector.get(MatSnackBar), 'open');

      (page.querySelector('[aria-label="Copy Client ID to clipboard"]') as HTMLElement).click();

      await vi.waitFor(() =>
        expect(open).toHaveBeenCalledWith(
          'Could not copy the Client ID. Select it in its field and copy it by hand.',
          'Close',
          expect.objectContaining({ duration: expect.any(Number) })
        )
      );
    });

    it('does not suggest copying the masked secret by hand', async () => {
      secret = 'demo-secret';
      const page = await render();
      const open = vi.spyOn(fixture.debugElement.injector.get(MatSnackBar), 'open');

      (page.querySelector('[aria-label="Copy Client Secret to clipboard"]') as HTMLElement).click();

      await vi.waitFor(() =>
        expect(open).toHaveBeenCalledWith(
          'Could not copy the Client Secret',
          'Close',
          expect.objectContaining({ duration: expect.any(Number) })
        )
      );
    });
  });
});
