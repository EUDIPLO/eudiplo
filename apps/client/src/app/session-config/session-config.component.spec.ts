import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { MatSelect } from '@angular/material/select';
import { MatSnackBar } from '@angular/material/snack-bar';
import { By } from '@angular/platform-browser';
import { client } from '@eudiplo/sdk-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  expectResetAvailable,
  expectResetUnavailable,
  expectSaveWaiting,
  findButton as button,
  loseFocus,
  NOTHING_TO_RESET,
  RESET_WHILE_SAVING,
} from '../common/settings-screen.testing';
import { ConfigOwnershipService } from '../config-portability/config-ownership.service';
import { SessionConfigComponent } from './session-config.component';

/** A response, or `'unreachable'` for a backend that does not answer. */
type StubResponse = { status: number; body?: unknown } | 'unreachable';

describe('SessionConfigComponent', () => {
  let responses: Record<string, StubResponse>;
  let requests: string[];
  let putBodies: unknown[];
  let snackBar: { open: ReturnType<typeof vi.fn> };
  let fixture: ComponentFixture<SessionConfigComponent>;

  async function render(): Promise<HTMLElement> {
    fixture = TestBed.createComponent(SessionConfigComponent);
    fixture.detectChanges();
    await vi.waitFor(() => expect(fixture.componentInstance.isLoading).toBe(false));
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  /** Clicks a button and waits for the snackbar that reports the outcome. */
  async function clickAndWait(element: HTMLElement, label: string): Promise<void> {
    snackBar.open.mockClear();
    button(element, label).click();
    await vi.waitFor(() => expect(snackBar.open).toHaveBeenCalled());
    fixture.detectChanges();
  }

  function settingsTitle(element: HTMLElement): HTMLElement | null {
    return element.querySelector('mat-card-title');
  }

  /** Opens the cleanup mode select and returns its "Use global default" option. */
  function globalDefaultOption(): HTMLElement {
    const select = fixture.debugElement.query(By.directive(MatSelect))
      .componentInstance as MatSelect;
    select.open();
    fixture.detectChanges();
    const option = document.querySelector<HTMLElement>('.cdk-overlay-container mat-option');
    if (!option?.textContent?.includes('Use global default')) {
      throw new Error('No "Use global default" option');
    }
    return option;
  }

  /** Picks a cleanup mode option through the opened select, as a user would. */
  function pickCleanupMode(label: string): void {
    const select = fixture.debugElement.query(By.directive(MatSelect))
      .componentInstance as MatSelect;
    select.open();
    fixture.detectChanges();
    const option = [
      ...document.querySelectorAll<HTMLElement>('.cdk-overlay-container mat-option'),
    ].find((o) => o.textContent?.includes(label));
    if (!option) throw new Error(`No option "${label}"`);
    option.click();
    fixture.detectChanges();
  }

  beforeEach(async () => {
    responses = {};
    requests = [];
    putBodies = [];
    snackBar = { open: vi.fn() };
    client.setConfig({
      fetch: vi.fn<typeof fetch>(async (input) => {
        const request = input as Request;
        const key = `${request.method} ${new URL(request.url).pathname}`;
        requests.push(key);
        if (request.method === 'PUT') putBodies.push(await request.json());
        const stub = responses[key] ?? { status: 404, body: {} };
        if (stub === 'unreachable') throw new TypeError('Failed to fetch');
        return new Response(stub.status === 204 ? null : JSON.stringify(stub.body ?? {}), {
          status: stub.status,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    });
    await TestBed.configureTestingModule({
      imports: [SessionConfigComponent],
      providers: [
        {
          provide: ConfigOwnershipService,
          useValue: { get: async () => undefined },
        },
      ],
    })
      // The component imports MatSnackBarModule, whose provider wins over a root provider.
      .overrideProvider(MatSnackBar, { useValue: snackBar })
      .compileComponents();
  });

  afterEach(() => {
    client.setConfig({ fetch: () => new Promise<Response>(() => undefined) });
    vi.unstubAllGlobals();
  });

  const loadFailure: StubResponse = {
    status: 500,
    body: { statusCode: 500, message: 'Internal server error' },
  };
  const conflict = {
    statusCode: 409,
    error: 'Conflict',
    message:
      "Tenant 'tenant' is file-managed by provisioning. Detach it before changing it through the API or UI.",
  };

  it('shows an error with a retry instead of an editable form when loading fails', async () => {
    responses['GET /api/session-config'] = loadFailure;

    const element = await render();

    expect(element.querySelector('[role="alert"]')?.textContent).toContain(
      'Failed to load the session settings: Internal server error'
    );
    expect(element.querySelector('form')).toBeNull();
    expect(element.textContent).not.toContain('Save Configuration');
    expect(button(element, 'Retry')).toBeTruthy();
  });

  it('says so when the backend cannot be reached', async () => {
    responses['GET /api/session-config'] = 'unreachable';

    const element = await render();

    expect(element.querySelector('[role="alert"]')?.textContent).toContain(
      'Failed to load the session settings: the backend could not be reached. ' +
        'Check the connection and try again.'
    );
    expect(element.querySelector('form')).toBeNull();
  });

  it('shows the form once a retry after a failed load succeeds', async () => {
    responses['GET /api/session-config'] = loadFailure;
    const element = await render();

    responses['GET /api/session-config'] = { status: 200, body: { ttlSeconds: 3600 } };
    button(element, 'Retry').click();
    await vi.waitFor(() => expect(fixture.componentInstance.loadError).toBe(''));
    await vi.waitFor(() => expect(fixture.componentInstance.isLoading).toBe(false));
    fixture.detectChanges();

    expect(element.querySelector('form')).not.toBeNull();
    expect(fixture.componentInstance.configForm.value.ttlSeconds).toBe(3600);
    const summary = element.querySelector('.summary-card')?.textContent;
    expect(summary).toContain('1 hour');
    expect(summary).toContain('Global default (SESSION_CLEANUP_MODE of this instance)');
    expect(summary).not.toContain('Full Delete');
  });

  it('shows the backend message when saving is rejected', async () => {
    responses['GET /api/session-config'] = { status: 200, body: {} };
    responses['PUT /api/session-config'] = { status: 409, body: conflict };
    const element = await render();
    fixture.componentInstance.configForm.patchValue({ ttlSeconds: 3600 });
    fixture.detectChanges();

    loseFocus();
    await clickAndWait(element, 'Save Configuration');

    expect(snackBar.open.mock.lastCall?.[0]).toBe(
      "Failed to save configuration: Tenant 'tenant' is file-managed by provisioning. Detach it before changing it through the API or UI."
    );
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(document.activeElement).toBe(button(element, 'Save Configuration'));
    });
  });

  it('leaves the cleanup mode out of the update while it follows the global default', async () => {
    responses['GET /api/session-config'] = { status: 200, body: {} };
    responses['PUT /api/session-config'] = { status: 200, body: { ttlSeconds: 3600 } };
    const element = await render();

    expect(fixture.componentInstance.configForm.value.cleanupMode).toBeNull();
    expect(globalDefaultOption().getAttribute('aria-disabled')).toBe('false');
    // Nothing is stored, so there is nothing to reset.
    expectResetUnavailable(fixture, NOTHING_TO_RESET);
    const confirm = vi.fn<(message?: string) => boolean>(() => true);
    vi.stubGlobal('confirm', confirm);
    // disabledInteractive does not stop the click on a <button>.
    button(element, 'Reset to Defaults').click();
    await new Promise((resolve) => setTimeout(resolve));
    expect(confirm).not.toHaveBeenCalled();
    expect(requests).not.toContain('DELETE /api/session-config');
    expect(element.textContent).toContain('This tenant already follows the global defaults.');
    pickCleanupMode('Anonymize');
    pickCleanupMode('Use global default');
    expect(fixture.componentInstance.configForm.value.cleanupMode).toBeNull();
    fixture.componentInstance.configForm.patchValue({ ttlSeconds: 3600 });
    fixture.detectChanges();
    await clickAndWait(element, 'Save Configuration');

    expect(putBodies).toEqual([{ ttlSeconds: 3600 }]);
  });

  it('sends a chosen cleanup mode and leaves an empty TTL out', async () => {
    responses['GET /api/session-config'] = { status: 200, body: {} };
    responses['PUT /api/session-config'] = { status: 200, body: { cleanupMode: 'anonymize' } };
    const element = await render();

    fixture.componentInstance.configForm.patchValue({ cleanupMode: 'anonymize' });
    fixture.detectChanges();
    expect(element.textContent).toContain('Once saved, only Reset to Defaults');
    await clickAndWait(element, 'Save Configuration');

    expect(putBodies).toEqual([{ cleanupMode: 'anonymize' }]);
    expect(snackBar.open.mock.lastCall?.[0]).toBe('Session configuration saved successfully');
    expect(element.querySelector('.summary-card')?.textContent).toContain('Anonymize');
    expect(globalDefaultOption().getAttribute('aria-disabled')).toBe('true');
  });

  it('removes a stored TTL with null and keeps the stored cleanup mode', async () => {
    responses['GET /api/session-config'] = {
      status: 200,
      body: { ttlSeconds: 3600, cleanupMode: 'anonymize' },
    };
    responses['PUT /api/session-config'] = { status: 200, body: { cleanupMode: 'anonymize' } };
    const element = await render();

    // The API cannot clear a stored mode, so the option must not pretend to.
    expect(globalDefaultOption().getAttribute('aria-disabled')).toBe('true');
    fixture.componentInstance.configForm.patchValue({ ttlSeconds: null });
    fixture.detectChanges();
    await clickAndWait(element, 'Save Configuration');

    expect(putBodies).toEqual([{ ttlSeconds: null, cleanupMode: 'anonymize' }]);
  });

  it('resets only after confirmation and then follows the global defaults again', async () => {
    const confirm = vi.fn<(message?: string) => boolean>(() => false);
    vi.stubGlobal('confirm', confirm);
    responses['GET /api/session-config'] = {
      status: 200,
      body: { ttlSeconds: 3600, cleanupMode: 'anonymize' },
    };
    responses['DELETE /api/session-config'] = { status: 204 };
    responses['PUT /api/session-config'] = { status: 200, body: { ttlSeconds: 3600 } };
    const element = await render();

    button(element, 'Reset to Defaults').click();
    expect(confirm.mock.lastCall?.[0]).toContain(
      'the TTL of 1 hour and the cleanup mode "Anonymize"'
    );
    expect(fixture.componentInstance.isSaving).toBe(false);
    // The SDK awaits before it calls fetch; let a cancelled reset run to completion.
    await new Promise((resolve) => setTimeout(resolve));
    expect(requests).not.toContain('DELETE /api/session-config');
    expect(snackBar.open).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    expectResetAvailable(fixture);
    await clickAndWait(element, 'Reset to Defaults');
    expect(requests).toContain('DELETE /api/session-config');
    expect(fixture.componentInstance.configForm.value).toEqual({
      ttlSeconds: null,
      cleanupMode: null,
    });
    expect(fixture.componentInstance.hasStoredCleanupMode).toBe(false);
    expect(element.querySelector('.summary-card')?.textContent).toContain(
      'Global default (SESSION_CLEANUP_MODE of this instance)'
    );
    expectResetUnavailable(fixture, NOTHING_TO_RESET);
    expect(element.textContent).toContain('This tenant already follows the global defaults.');

    fixture.componentInstance.configForm.patchValue({ ttlSeconds: 3600 });
    fixture.detectChanges();
    await clickAndWait(element, 'Save Configuration');
    expect(putBodies).toEqual([{ ttlSeconds: 3600 }]);
  });

  it('refuses a reset while a change is being saved', async () => {
    const confirm = vi.fn<(message?: string) => boolean>(() => true);
    vi.stubGlobal('confirm', confirm);
    responses['GET /api/session-config'] = { status: 200, body: { cleanupMode: 'anonymize' } };
    const element = await render();

    fixture.componentInstance.isSaving = true;
    fixture.detectChanges();
    expectResetUnavailable(fixture, RESET_WHILE_SAVING);
    // disabledInteractive does not stop the click on a <button>.
    button(element, 'Reset to Defaults').click();
    await new Promise((resolve) => setTimeout(resolve));

    expect(confirm).not.toHaveBeenCalled();
    expect(requests).not.toContain('DELETE /api/session-config');
  });

  it('moves focus to the settings title when a retry succeeds', async () => {
    responses['GET /api/session-config'] = loadFailure;
    const element = await render();

    responses['GET /api/session-config'] = { status: 200, body: {} };
    const retry = button(element, 'Retry');
    retry.focus();
    retry.click();

    // The retry removed the error card with its focused Retry button.
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(document.activeElement).toBe(settingsTitle(element));
    });
    expect(settingsTitle(element)?.textContent).toContain('Session Retention Settings');
  });

  it('keeps Save focusable while saving and gives focus back to it once saving has finished', async () => {
    responses['GET /api/session-config'] = { status: 200, body: {} };
    responses['PUT /api/session-config'] = { status: 200, body: { ttlSeconds: 3600 } };
    const element = await render();
    fixture.componentInstance.configForm.patchValue({ ttlSeconds: 3600 });
    fixture.detectChanges();

    const save = button(element, 'Save Configuration');
    save.focus();
    save.click();
    fixture.detectChanges();
    expectSaveWaiting(fixture, 'Save Configuration');
    // A second click while the first save runs sends nothing.
    save.click();
    loseFocus();
    expect(document.activeElement).toBe(document.body);

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(document.activeElement).toBe(save);
    });
    expect(putBodies).toHaveLength(1);
  });

  it('moves focus to the settings title when a reset ends with focus lost', async () => {
    vi.stubGlobal('confirm', () => true);
    responses['GET /api/session-config'] = { status: 200, body: { ttlSeconds: 3600 } };
    responses['DELETE /api/session-config'] = { status: 204 };
    const element = await render();

    // Safari, for one, does not focus a button on click.
    loseFocus();
    await clickAndWait(element, 'Reset to Defaults');

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(document.activeElement).toBe(settingsTitle(element));
    });
  });

  it('shows the backend message when resetting is rejected', async () => {
    vi.stubGlobal('confirm', () => true);
    responses['GET /api/session-config'] = { status: 200, body: { cleanupMode: 'anonymize' } };
    responses['DELETE /api/session-config'] = { status: 409, body: conflict };
    const element = await render();

    loseFocus();
    await clickAndWait(element, 'Reset to Defaults');

    expect(snackBar.open.mock.lastCall?.[0]).toContain(
      "Failed to reset configuration: Tenant 'tenant' is file-managed"
    );
    expect(fixture.componentInstance.hasStoredCleanupMode).toBe(true);
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(document.activeElement).toBe(settingsTitle(element));
    });
  });

  it('rejects a TTL that is not a whole number of seconds', async () => {
    responses['GET /api/session-config'] = { status: 200, body: {} };
    const element = await render();
    const ttl = fixture.componentInstance.configForm.get('ttlSeconds')!;

    ttl.setValue(90.5);
    ttl.markAsTouched();
    fixture.detectChanges();

    expect(ttl.hasError('integer')).toBe(true);
    expect(element.querySelector('mat-error')?.textContent).toContain(
      'Enter a whole number of seconds'
    );

    ttl.setValue(30);
    fixture.detectChanges();
    expect(element.querySelector('mat-error')?.textContent).toContain(
      'TTL must be at least 60 seconds'
    );
  });

  it('says which field keeps the settings from saving and focuses it', async () => {
    responses['GET /api/session-config'] = { status: 200, body: {} };
    const element = await render();
    fixture.componentInstance.configForm.patchValue({ ttlSeconds: 30 });
    fixture.detectChanges();
    const save = button(element, 'Save Configuration');
    expect(save.getAttribute('aria-disabled')).toBeNull();

    snackBar.open.mockClear();
    save.focus();
    save.click();

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(document.activeElement?.getAttribute('formcontrolname')).toBe('ttlSeconds');
    });
    expect(element.querySelector('mat-error')?.textContent).toContain(
      'TTL must be at least 60 seconds'
    );
    expect(snackBar.open).toHaveBeenCalledWith(
      'Check the highlighted fields in Session Time-to-Live (TTL).',
      'Close',
      expect.anything()
    );
    expect(requests).not.toContain('PUT /api/session-config');
  });

  it('spells out the TTL exactly', () => {
    const component = TestBed.createComponent(SessionConfigComponent).componentInstance;

    expect(component.formatTtl(null)).toBe('Global default (SESSION_TTL of this instance)');
    expect(component.formatTtl(60)).toBe('1 minute');
    expect(component.formatTtl(5400)).toBe('1 hour 30 minutes');
    expect(component.formatTtl(129600)).toBe('1 day 12 hours');
    expect(component.formatTtl(2592000)).toBe('30 days');
  });
});
