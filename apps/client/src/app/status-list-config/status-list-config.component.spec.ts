import { TestbedHarnessEnvironment } from '@angular/cdk/testing/testbed';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { MatSelectHarness } from '@angular/material/select/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
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
import { StatusListConfigComponent } from './status-list-config.component';

/**
 * A response, `'unreachable'` for a backend that does not answer, or `'empty'`
 * for a 200 with `Content-Length: 0` and no Content-Type, which is how Nest sends `null`.
 */
type StubResponse = { status: number; body?: unknown } | 'unreachable' | 'empty';

describe('StatusListConfigComponent', () => {
  let responses: Record<string, StubResponse>;
  let requests: string[];
  /** The parsed JSON body of the last request per method and path. */
  let bodies: Record<string, unknown>;
  let snackBar: { open: ReturnType<typeof vi.fn> };
  let fixture: ComponentFixture<StatusListConfigComponent>;

  const unreachableHint = 'the backend could not be reached. Check the connection and try again.';

  async function render(): Promise<HTMLElement> {
    fixture = TestBed.createComponent(StatusListConfigComponent);
    fixture.detectChanges();
    await vi.waitFor(() => expect(fixture.componentInstance.isLoading).toBe(false));
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  function settingsTitle(element: HTMLElement): HTMLElement | null {
    return element.querySelector('mat-card-title');
  }

  function select(name: string): Promise<MatSelectHarness> {
    return TestbedHarnessEnvironment.loader(fixture).getHarness(
      MatSelectHarness.with({ selector: `[formControlName="${name}"]` })
    );
  }

  /** Picks the option of a select whose text contains `title`, case-sensitively. */
  async function chooseOption(name: string, title: string): Promise<void> {
    const harness = await select(name);
    await harness.open();
    await harness.clickOptions({ text: new RegExp(title) });
  }

  /** Clicks a button and returns the message of the snackbar that reports the outcome. */
  async function click(element: HTMLElement, label: string): Promise<string> {
    snackBar.open.mockClear();
    button(element, label).click();
    await vi.waitFor(() => expect(snackBar.open).toHaveBeenCalled());
    return snackBar.open.mock.calls[0][0] as string;
  }

  beforeEach(async () => {
    responses = { 'GET /api/status-list-config': { status: 200, body: { capacity: 10000 } } };
    requests = [];
    bodies = {};
    snackBar = { open: vi.fn() };
    client.setConfig({
      fetch: vi.fn<typeof fetch>(async (input) => {
        const request = input as Request;
        const key = `${request.method} ${new URL(request.url).pathname}`;
        requests.push(key);
        const text = await request.clone().text();
        if (text) bodies[key] = JSON.parse(text);
        const stub = responses[key] ?? { status: 404, body: {} };
        if (stub === 'unreachable') throw new TypeError('Failed to fetch');
        if (stub === 'empty') {
          return new Response(null, { status: 200, headers: { 'Content-Length': '0' } });
        }
        return new Response(stub.status === 204 ? null : JSON.stringify(stub.body ?? {}), {
          status: stub.status,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    });
    await TestBed.configureTestingModule({
      imports: [StatusListConfigComponent],
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

  it('shows an error with a retry instead of an editable form when loading fails', async () => {
    responses['GET /api/status-list-config'] = {
      status: 500,
      body: { statusCode: 500, message: 'Internal server error' },
    };

    const element = await render();

    expect(element.querySelector('[role="alert"]')?.textContent).toContain(
      'Failed to load status list configuration: Internal server error'
    );
    expect(element.querySelector('form')).toBeNull();
    expect(element.textContent).not.toContain('Save Configuration');
    expect(element.textContent).not.toContain('Reset to Defaults');
    expect(button(element, 'Retry')).toBeTruthy();
    // The defaults in the hidden form must not replace the stored settings.
    await fixture.componentInstance.onSave();
    expect(requests).not.toContain('PUT /api/status-list-config');
  });

  it('says when the backend cannot be reached while loading', async () => {
    responses['GET /api/status-list-config'] = 'unreachable';

    const element = await render();

    expect(element.querySelector('[role="alert"]')?.textContent).toContain(
      `Failed to load status list configuration: ${unreachableHint}`
    );
    expect(element.querySelector('form')).toBeNull();

    button(element, 'Retry').click();
    await vi.waitFor(() =>
      expect(requests.filter((r) => r === 'GET /api/status-list-config')).toHaveLength(2)
    );
    await vi.waitFor(() => expect(fixture.componentInstance.isLoading).toBe(false));
    fixture.detectChanges();

    expect(element.querySelector('[role="alert"]')?.textContent).toContain(unreachableHint);
    expect(element.querySelector('form')).toBeNull();
    expect(button(element, 'Retry')).toBeTruthy();
    expect(snackBar.open).not.toHaveBeenCalled();
  });

  it('shows the stored settings once a retry after a failed load succeeds', async () => {
    responses['GET /api/status-list-config'] = 'unreachable';
    const element = await render();

    responses['GET /api/status-list-config'] = {
      status: 200,
      body: { capacity: 50000, bits: 2, enableAggregation: false },
    };
    const retry = button(element, 'Retry');
    retry.focus();
    retry.click();
    await vi.waitFor(() => expect(fixture.componentInstance.isLoading).toBe(false));
    fixture.detectChanges();

    expect(element.querySelector('[role="alert"]')).toBeNull();
    expect(element.querySelector('form')).not.toBeNull();
    // The retry removed the error card with its focused Retry button.
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(document.activeElement).toBe(settingsTitle(element));
    });
    expect(settingsTitle(element)?.textContent).toContain('Status List Settings');
    expect(fixture.componentInstance.configForm.value).toEqual({
      capacity: 50000,
      bits: 2,
      ttl: null,
      immediateUpdate: null,
      enableAggregation: false,
    });
    expect(button(element, 'Save Configuration').disabled).toBe(false);
  });

  it('offers no reset while nothing is stored', async () => {
    responses['GET /api/status-list-config'] = 'empty';

    const element = await render();

    expect(fixture.componentInstance.currentConfig).toStrictEqual({});
    expectResetUnavailable(fixture, NOTHING_TO_RESET);
    expect(element.textContent).toContain('This tenant already follows the global defaults.');
    const confirm = vi.fn<(message?: string) => boolean>(() => true);
    vi.stubGlobal('confirm', confirm);
    // disabledInteractive does not stop the click on a <button>.
    button(element, 'Reset to Defaults').click();
    await new Promise((resolve) => setTimeout(resolve));
    expect(confirm).not.toHaveBeenCalled();
    expect(requests).not.toContain('DELETE /api/status-list-config');
  });

  it('offers a reset once a save stores settings', async () => {
    responses['GET /api/status-list-config'] = 'empty';
    responses['PUT /api/status-list-config'] = {
      status: 200,
      body: { capacity: 1000 },
    };
    const element = await render();
    fixture.componentInstance.configForm.patchValue({ capacity: 1000 });
    fixture.detectChanges();

    expect(await click(element, 'Save Configuration')).toBe(
      'Status list configuration saved successfully'
    );
    fixture.detectChanges();

    expectResetAvailable(fixture);
  });

  it('counts stored false values and 1 bit as settings to reset', async () => {
    const confirm = vi.fn<(message?: string) => boolean>(() => false);
    vi.stubGlobal('confirm', confirm);
    responses['GET /api/status-list-config'] = {
      status: 200,
      body: { bits: 1, immediateUpdate: false, enableAggregation: false },
    };
    const element = await render();

    expectResetAvailable(fixture);
    button(element, 'Reset to Defaults').click();

    expect(confirm.mock.lastCall?.[0]).toContain(
      'This removes 1 bit per status, lazy JWT regeneration, and disabled aggregation. ' +
        'Afterwards, new status lists use STATUS_BITS; all status lists, ' +
        'including existing ones, use STATUS_IMMEDIATE_UPDATE and STATUS_ENABLE_AGGREGATION of ' +
        'this instance.'
    );
  });

  it('names only the instance variables that take over', async () => {
    const confirm = vi.fn<(message?: string) => boolean>(() => false);
    vi.stubGlobal('confirm', confirm);
    responses['GET /api/status-list-config'] = { status: 200, body: { ttl: 900 } };
    let element = await render();

    button(element, 'Reset to Defaults').click();
    expect(confirm.mock.lastCall?.[0]).toContain(
      'This removes the TTL of 15 minutes. Afterwards, all status lists, including existing ' +
        'ones, use STATUS_TTL of this instance.'
    );

    fixture.destroy();
    responses['GET /api/status-list-config'] = {
      status: 200,
      body: { capacity: 1000, bits: 2, enableAggregation: true },
    };
    element = await render();

    button(element, 'Reset to Defaults').click();
    expect(confirm.mock.lastCall?.[0]).toContain(
      `This removes the capacity of ${(1000).toLocaleString()} entries, 2 bits per status, and ` +
        'enabled aggregation. Afterwards, new status lists use STATUS_CAPACITY and STATUS_BITS; ' +
        'all status lists, including existing ones, use STATUS_ENABLE_AGGREGATION of this instance.'
    );
  });

  it('resets only after confirmation and then offers no further reset', async () => {
    const confirm = vi.fn<(message?: string) => boolean>(() => false);
    vi.stubGlobal('confirm', confirm);
    responses['GET /api/status-list-config'] = {
      status: 200,
      body: { capacity: 50000, ttl: 900, immediateUpdate: true },
    };
    responses['DELETE /api/status-list-config'] = { status: 204 };
    const element = await render();

    button(element, 'Reset to Defaults').click();
    expect(confirm.mock.lastCall?.[0]).toContain(
      `This removes the capacity of ${(50000).toLocaleString()} entries, the TTL of 15 minutes, ` +
        'and immediate JWT ' +
        'regeneration. Afterwards, new status lists use STATUS_CAPACITY; all ' +
        'status lists, including existing ones, use STATUS_TTL and STATUS_IMMEDIATE_UPDATE of ' +
        'this instance.'
    );
    expect(fixture.componentInstance.isSaving).toBe(false);
    // The SDK awaits before it calls fetch; let a cancelled reset run to completion.
    await new Promise((resolve) => setTimeout(resolve));
    expect(requests).not.toContain('DELETE /api/status-list-config');
    expect(snackBar.open).not.toHaveBeenCalled();
    expect(fixture.componentInstance.configForm.value.capacity).toBe(50000);

    confirm.mockReturnValue(true);
    expect(await click(element, 'Reset to Defaults')).toBe(
      'Status list configuration reset to defaults'
    );
    fixture.detectChanges();
    expect(requests).toContain('DELETE /api/status-list-config');
    expect(fixture.componentInstance.configForm.value).toEqual({
      capacity: null,
      bits: null,
      ttl: null,
      immediateUpdate: null,
      enableAggregation: null,
    });
    expectResetUnavailable(fixture, NOTHING_TO_RESET);
  });

  it('refuses a reset while a change is being saved', async () => {
    const confirm = vi.fn<(message?: string) => boolean>(() => true);
    vi.stubGlobal('confirm', confirm);
    const element = await render();

    fixture.componentInstance.isSaving = true;
    fixture.detectChanges();
    expectResetUnavailable(fixture, RESET_WHILE_SAVING);
    button(element, 'Reset to Defaults').click();
    await new Promise((resolve) => setTimeout(resolve));

    expect(confirm).not.toHaveBeenCalled();
    expect(requests).not.toContain('DELETE /api/status-list-config');
  });

  it('moves focus to the settings title when a reset ends with focus lost', async () => {
    vi.stubGlobal('confirm', () => true);
    responses['DELETE /api/status-list-config'] = { status: 204 };
    const element = await render();

    // Safari, for one, does not focus a button on click.
    loseFocus();
    await click(element, 'Reset to Defaults');

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(document.activeElement).toBe(settingsTitle(element));
    });
  });

  it('keeps Save focusable while saving and gives focus back to it once saving has finished', async () => {
    responses['PUT /api/status-list-config'] = { status: 200, body: { capacity: 10000 } };
    const element = await render();

    const save = button(element, 'Save Configuration');
    save.focus();
    save.click();
    fixture.detectChanges();
    expectSaveWaiting(fixture, 'Save Configuration');
    // A second click while the first save runs sends nothing.
    save.click();
    loseFocus();

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(document.activeElement).toBe(save);
    });
    expect(requests.filter((request) => request.startsWith('PUT'))).toHaveLength(1);
  });

  it('shows unstored settings as the global default of the instance', async () => {
    responses['GET /api/status-list-config'] = 'empty';

    const element = await render();

    for (const variable of [
      'STATUS_CAPACITY',
      'STATUS_BITS',
      'STATUS_TTL',
      'STATUS_IMMEDIATE_UPDATE',
      'STATUS_ENABLE_AGGREGATION',
    ]) {
      expect(element.textContent).toContain(`Global default (${variable} of this instance)`);
    }
    expect(element.textContent).not.toContain('global default (10,000)');
    expect(element.textContent).not.toContain('global default (1 hour)');
    expect(element.querySelector('mat-slide-toggle')).toBeNull();
  });

  it('shows stored false values as chosen settings, not as the global default', async () => {
    responses['GET /api/status-list-config'] = {
      status: 200,
      body: { bits: 1, immediateUpdate: false, enableAggregation: false },
    };

    const element = await render();

    expect(await (await select('bits')).getValueText()).toBe('1 bit');
    expect(await (await select('immediateUpdate')).getValueText()).toBe('Lazy');
    expect(await (await select('enableAggregation')).getValueText()).toBe('Disabled');
    expect(element.textContent).toContain('Global default (STATUS_CAPACITY of this instance)');
    expect(element.textContent).toContain('Global default (STATUS_TTL of this instance)');
  });

  it('saves only the chosen settings after a reset', async () => {
    vi.stubGlobal('confirm', () => true);
    responses['GET /api/status-list-config'] = {
      status: 200,
      body: { capacity: 50000, bits: 2, immediateUpdate: true, enableAggregation: false },
    };
    responses['DELETE /api/status-list-config'] = { status: 204 };
    responses['PUT /api/status-list-config'] = { status: 200, body: { ttl: 900 } };
    const element = await render();

    await click(element, 'Reset to Defaults');
    fixture.componentInstance.configForm.patchValue({ ttl: 900 });
    fixture.detectChanges();
    expect(await click(element, 'Save Configuration')).toBe(
      'Status list configuration saved successfully'
    );

    expect(bodies['PUT /api/status-list-config']).toStrictEqual({ ttl: 900 });
  });

  it('keeps stored settings on save and drops those set back to the global default', async () => {
    responses['GET /api/status-list-config'] = {
      status: 200,
      body: { bits: 2, immediateUpdate: false, enableAggregation: false },
    };
    // The backend's answer, not the form, is what the page shows afterwards.
    responses['PUT /api/status-list-config'] = {
      status: 200,
      body: { capacity: 2000, bits: 2, immediateUpdate: false },
    };
    const element = await render();

    fixture.componentInstance.configForm.patchValue({ capacity: 1000 });
    await chooseOption('enableAggregation', 'Use global default');
    expect(await (await select('enableAggregation')).getValueText()).toBe(
      'Global default (STATUS_ENABLE_AGGREGATION of this instance)'
    );
    await click(element, 'Save Configuration');

    expect(bodies['PUT /api/status-list-config']).toStrictEqual({
      capacity: 1000,
      bits: 2,
      immediateUpdate: false,
    });
    expect(fixture.componentInstance.configForm.value).toEqual({
      capacity: 2000,
      bits: 2,
      ttl: null,
      immediateUpdate: false,
      enableAggregation: null,
    });
  });

  it('keeps the edited values when a save fails', async () => {
    responses['PUT /api/status-list-config'] = {
      status: 400,
      body: { statusCode: 400, message: 'Validation failed' },
    };
    const element = await render();

    fixture.componentInstance.configForm.patchValue({ capacity: 1000, ttl: 900 });
    await click(element, 'Save Configuration');

    expect(fixture.componentInstance.configForm.value).toMatchObject({ capacity: 1000, ttl: 900 });
    expect(fixture.componentInstance.currentConfig).toEqual({ capacity: 10000 });
  });

  it('warns about immediate regeneration only when it is chosen', async () => {
    const element = await render();
    expect(element.querySelector('.info-box.warning')).toBeNull();

    await chooseOption('immediateUpdate', 'Immediate');
    fixture.detectChanges();

    expect(element.querySelector('.info-box.warning')?.textContent).toContain('Performance note');
    expect(fixture.componentInstance.configForm.value.immediateUpdate).toBe(true);
  });

  it('sends no settings when nothing is stored or chosen', async () => {
    responses['GET /api/status-list-config'] = 'empty';
    responses['PUT /api/status-list-config'] = { status: 200, body: {} };
    const element = await render();

    await click(element, 'Save Configuration');

    expect(bodies['PUT /api/status-list-config']).toStrictEqual({});
  });

  it('rejects a capacity or TTL that is not a whole number', async () => {
    const element = await render();
    const form = fixture.componentInstance.configForm;

    form.patchValue({ capacity: 1000.5, ttl: 90.5 });
    form.markAllAsTouched();
    fixture.detectChanges();

    expect(form.invalid).toBe(true);
    const errors = [...element.querySelectorAll('mat-error')].map((e) => e.textContent?.trim());
    expect(errors).toEqual(['Enter a whole number of entries', 'Enter a whole number of seconds']);
    await fixture.componentInstance.onSave();
    expect(requests).not.toContain('PUT /api/status-list-config');
  });

  it('says which fields keep the settings from saving and focuses the first one', async () => {
    const element = await render();
    fixture.componentInstance.configForm.patchValue({ ttl: 30 });
    fixture.detectChanges();
    const save = button(element, 'Save Configuration');
    expect(save.disabled).toBe(false);
    expect(save.getAttribute('aria-disabled')).toBeNull();

    snackBar.open.mockClear();
    save.focus();
    save.click();

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(document.activeElement?.getAttribute('formcontrolname')).toBe('ttl');
    });
    const errors = [...element.querySelectorAll('mat-error')].map((e) => e.textContent?.trim());
    expect(errors).toEqual(['TTL must be at least 60 seconds']);
    expect(snackBar.open).toHaveBeenCalledWith(
      'Check the highlighted fields in JWT Time-to-Live (TTL).',
      'Close',
      expect.anything()
    );
    expect(requests).not.toContain('PUT /api/status-list-config');
  });

  it('rejects a capacity or TTL below the minimum', async () => {
    const element = await render();
    const form = fixture.componentInstance.configForm;

    form.patchValue({ capacity: 50, ttl: 30 });
    form.markAllAsTouched();
    fixture.detectChanges();

    const errors = [...element.querySelectorAll('mat-error')].map((e) => e.textContent?.trim());
    expect(errors).toEqual(['Capacity must be at least 100', 'TTL must be at least 60 seconds']);
  });

  it('names the field the backend rejected on save', async () => {
    responses['PUT /api/status-list-config'] = {
      status: 400,
      body: {
        statusCode: 400,
        message: 'Validation failed',
        errors: [{ path: ['capacity'], message: 'Too big', code: 'too_big' }],
      },
    };
    const element = await render();

    expect(await click(element, 'Save Configuration')).toBe(
      'Failed to save configuration: Validation failed (capacity: Too big)'
    );
  });

  it('says when the backend cannot be reached on save and on reset', async () => {
    vi.stubGlobal('confirm', () => true);
    responses['PUT /api/status-list-config'] = 'unreachable';
    responses['DELETE /api/status-list-config'] = 'unreachable';
    const element = await render();

    loseFocus();
    expect(await click(element, 'Save Configuration')).toBe(
      `Failed to save configuration: ${unreachableHint}`
    );
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(document.activeElement).toBe(button(element, 'Save Configuration'));
    });
    loseFocus();
    expect(await click(element, 'Reset to Defaults')).toBe(
      `Failed to reset configuration: ${unreachableHint}`
    );
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(document.activeElement).toBe(settingsTitle(element));
    });
    // The stored settings are still there, so Reset stays available.
    fixture.detectChanges();
    expect(snackBar.open).toHaveBeenCalledTimes(1);
    expect(fixture.componentInstance.configForm.value.capacity).toBe(10000);
    expectResetAvailable(fixture);
  });

  it("shows the backend's reason when saving is rejected", async () => {
    responses['PUT /api/status-list-config'] = {
      status: 409,
      body: {
        statusCode: 409,
        error: 'Conflict',
        message:
          "Tenant 'tenant' is file-managed by provisioning. Detach it before changing it through the API or UI.",
      },
    };
    const element = await render();

    expect(await click(element, 'Save Configuration')).toBe(
      "Failed to save configuration: Tenant 'tenant' is file-managed by provisioning. Detach it before changing it through the API or UI."
    );
  });
});
