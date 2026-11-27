import { ApplicationRef } from '@angular/core';
import { ChangeDetectorRef } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ActivatedRoute, Router, provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PresentationRequestComponent } from './presentation-request.component';
import { PresentationManagementService } from '../presentation-config/presentation-management.service';
import { expectAvailable, expectUnavailable } from '../../common/unavailable-action.testing';

describe('PresentationRequestComponent', () => {
  let component: PresentationRequestComponent;
  let fixture: ComponentFixture<PresentationRequestComponent>;
  let service: {
    loadConfigurations: ReturnType<typeof vi.fn>;
    checkPresentationReadiness: ReturnType<typeof vi.fn>;
    getOffer: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    service = {
      loadConfigurations: vi.fn().mockResolvedValue([{ id: 'pid-verification' }]),
      checkPresentationReadiness: vi.fn().mockResolvedValue({ ready: true }),
      getOffer: vi.fn().mockResolvedValue({ session: 'session-id' }),
    };

    await TestBed.configureTestingModule({
      imports: [PresentationRequestComponent],
      providers: [
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { snapshot: { params: {} } } },
        { provide: PresentationManagementService, useValue: service },
        { provide: MatSnackBar, useValue: { open: vi.fn() } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(PresentationRequestComponent);
    component = fixture.componentInstance;
  });

  /** Selects a configuration as the user does, so that its readiness is checked. */
  async function choose(value: Record<string, unknown>): Promise<void> {
    fixture.detectChanges();
    await fixture.whenStable();
    component.form.patchValue(value);
    await vi.waitFor(() => expect(component.checkingReadiness).toBe(false));
  }

  const generateButton = () =>
    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
      'button[type="submit"]'
    )!;

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('says before a request is created that a config without issuer trust refuses every presentation', async () => {
    const credential = { id: 'pid', format: 'dc+sd-jwt', meta: { vct_values: ['urn:x'] } };
    service.loadConfigurations.mockResolvedValue([
      { id: 'stale', dcql_query: { credentials: [credential] } },
      { id: 'open', allowUntrustedIssuers: true, dcql_query: { credentials: [credential] } },
    ]);
    fixture.detectChanges();
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;

    component.form.patchValue({ requestId: 'stale' });
    fixture.detectChanges();
    expect(component.queriesWithoutTrust).toEqual(['pid']);
    expect(element.textContent).toContain('Every presentation against this config is refused');

    component.form.patchValue({ requestId: 'open' });
    fixture.detectChanges();
    expect(component.queriesWithoutTrust).toEqual([]);
    expect(element.textContent).toContain("the issuer's authority is not validated");
  });

  describe('Generate Request', () => {
    let open: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      // The component's own injector provides the snack bar it uses.
      open = vi.spyOn(fixture.debugElement.injector.get(MatSnackBar), 'open');
      service.loadConfigurations.mockResolvedValue([{ id: 'pid' }, { id: 'mdl' }]);
    });

    it('says that a configuration is missing, focuses its select and sends nothing', async () => {
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
      const generate = generateButton();
      expectAvailable(fixture, generate);

      generate.focus();
      generate.click();

      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(document.activeElement?.getAttribute('formcontrolname')).toBe('requestId');
      });
      expect(fixture.nativeElement.textContent).toContain('Please select a verification config');
      expect(open).toHaveBeenLastCalledWith(
        'Check the highlighted fields.',
        'Close',
        expect.anything()
      );
      expect(service.checkPresentationReadiness).not.toHaveBeenCalled();
      expect(service.getOffer).not.toHaveBeenCalled();
    });

    it('waits while the request is generated: a second click sends nothing', async () => {
      service.getOffer.mockReturnValue(new Promise(() => undefined));
      await choose({ requestId: 'pid' });
      fixture.detectChanges();
      const generate = generateButton();
      expectAvailable(fixture, generate);

      generate.click();
      await vi.waitFor(() => expect(service.getOffer).toHaveBeenCalled());
      fixture.detectChanges();
      generate.click();
      await fixture.whenStable();
      fixture.detectChanges();

      expect(service.getOffer).toHaveBeenCalledOnce();
      expectUnavailable(fixture, generate, 'Generating the verification request…');
    });

    it('says while the configuration is checked that it waits for the check', async () => {
      service.checkPresentationReadiness.mockReturnValue(new Promise(() => undefined));
      fixture.detectChanges();
      await fixture.whenStable();
      component.form.patchValue({ requestId: 'pid' });
      fixture.detectChanges();

      expectUnavailable(
        fixture,
        generateButton(),
        'Checking whether the request can be generated…'
      );
      await component.onSubmit();
      expect(service.getOffer).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
    });

    it('says that the configurations could not be loaded instead of that none exists', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      service.loadConfigurations.mockRejectedValue({ statusCode: 503, message: 'Unavailable' });
      fixture.detectChanges();
      // The error snackbar keeps a timer running, so the fixture does not get stable.
      await vi.waitFor(() => expect(component.loading).toBe(false));
      fixture.detectChanges();

      const page = fixture.nativeElement as HTMLElement;
      // Nothing can be requested, so the form stays hidden behind the error card.
      expect(page.querySelector('form')).toBeNull();
      expect(page.querySelector('app-load-error')?.textContent).toContain(
        'Failed to load verification configs: Unavailable'
      );
      expect(page.textContent).not.toContain('No verification configs');
    });

    it('loads the configurations again on Retry and continues from the heading', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      service.loadConfigurations.mockRejectedValueOnce({ statusCode: 503, message: 'Unavailable' });
      fixture.detectChanges();
      await vi.waitFor(() => expect(component.loading).toBe(false));
      fixture.detectChanges();
      const page = fixture.nativeElement as HTMLElement;
      const retry = [...page.querySelectorAll<HTMLButtonElement>('app-load-error button')].find(
        (button) => button.textContent?.includes('Retry')
      )!;

      retry.focus();
      retry.click();
      await vi.waitFor(() => {
        fixture.detectChanges();
        TestBed.inject(ApplicationRef).tick();
        expect(page.querySelector('app-load-error')).toBeNull();
        expect(document.activeElement).toBe(page.querySelector('h1'));
      });
      expect(component.configs.map((config) => config.id)).toEqual(['pid', 'mdl']);
    });

    it('selects the configuration the page was opened for and generates nothing by itself', async () => {
      TestBed.inject(ActivatedRoute).snapshot.params['id'] = 'pid';
      fixture.detectChanges();
      await fixture.whenStable();

      await vi.waitFor(() => expect(component.loading).toBe(false));
      await vi.waitFor(() => {
        expect(service.checkPresentationReadiness).toHaveBeenCalled();
        expect(component.checkingReadiness).toBe(false);
      });
      // A submit on arrival would check the readiness again before it generates.
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(component.form.value.requestId).toBe('pid');
      expect(service.checkPresentationReadiness).toHaveBeenCalledWith('pid');
      // Once for the selection and once on arrival; a submit would check a third time.
      expect(service.checkPresentationReadiness).toHaveBeenCalledTimes(2);
      expect(service.getOffer).not.toHaveBeenCalled();
    });

    it('sends transaction data only while the override is switched on', async () => {
      const transactionData = [{ type: 'payment', credential_ids: ['pid'] }];
      await choose({ requestId: 'pid', transaction_data: JSON.stringify(transactionData) });
      vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);

      component.showTransactionDataOverride = true;
      await component.onSubmit();
      expect(service.getOffer).toHaveBeenLastCalledWith({
        requestId: 'pid',
        response_type: 'uri',
        transaction_data: transactionData,
      });

      // Switched off, the editor is hidden and still holds what was typed.
      component.showTransactionDataOverride = false;
      await component.onSubmit();
      expect(service.getOffer).toHaveBeenLastCalledWith({ requestId: 'pid', response_type: 'uri' });
    });

    it('generates the request when the hidden override editor was left with an error', async () => {
      await choose({ requestId: 'pid', transaction_data: '{ not json' });
      vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
      // What the editor reported before the override was switched off and it went away.
      component.form.get('transaction_data')!.setErrors({ json: true });
      component.showTransactionDataOverride = false;

      await component.onSubmit();

      expect(service.getOffer).toHaveBeenCalledWith({ requestId: 'pid', response_type: 'uri' });
    });

    it('switches the transaction data override off on Reset', async () => {
      await choose({ requestId: 'pid', transaction_data: '[]' });
      component.showTransactionDataOverride = true;

      component.resetForm();

      expect(component.showTransactionDataOverride).toBe(false);
      expect(component.form.value.transaction_data).toBeNull();
    });

    it('offers no form and says why on submit when there is no configuration', async () => {
      service.loadConfigurations.mockResolvedValue([]);
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
      const page = fixture.nativeElement as HTMLElement;
      expect(page.textContent).toContain('No verification configs');
      expect(page.querySelector('form')).toBeNull();

      await component.onSubmit();

      expect(open).toHaveBeenLastCalledWith(
        'There is no verification config to request.',
        'Close',
        expect.anything()
      );
      expect(service.getOffer).not.toHaveBeenCalled();
    });

    it('checks the configuration again on submit and says when it is no longer ready', async () => {
      service.checkPresentationReadiness
        .mockResolvedValueOnce({ ready: true })
        .mockResolvedValueOnce({ ready: false, reason: 'The access key chain was deleted.' });
      await choose({ requestId: 'pid' });

      await component.onSubmit();

      expect(service.checkPresentationReadiness).toHaveBeenCalledTimes(2);
      expect(open).toHaveBeenLastCalledWith(
        'The access key chain was deleted.',
        'Close',
        expect.anything()
      );
      expect(service.getOffer).not.toHaveBeenCalled();
    });

    it('checks a configuration that was not ready again on submit and generates once it is', async () => {
      service.checkPresentationReadiness
        .mockRejectedValueOnce({ statusCode: 503, message: 'Service Unavailable' })
        .mockResolvedValueOnce({ ready: true });
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      await choose({ requestId: 'pid' });
      fixture.detectChanges();
      expect(generateButton().getAttribute('aria-disabled')).toBe('true');

      await component.onSubmit();

      expect(service.getOffer).toHaveBeenCalledWith({ requestId: 'pid', response_type: 'uri' });
    });

    it('says why a configuration that is not ready cannot be requested, also on submit', async () => {
      service.checkPresentationReadiness.mockResolvedValue({
        ready: false,
        reason: 'No access certificate is configured.',
      });
      await choose({ requestId: 'pid' });
      fixture.detectChanges();
      expectUnavailable(fixture, generateButton(), 'No access certificate is configured.');

      // Enter in a field submits the form without showing the tooltip.
      await component.onSubmit();

      expect(open).toHaveBeenLastCalledWith(
        'No access certificate is configured.',
        'Close',
        expect.anything()
      );
      // The submit checked the configuration again.
      expect(service.checkPresentationReadiness).toHaveBeenCalledTimes(2);
      expect(service.getOffer).not.toHaveBeenCalled();
    });
  });

  describe('DC API origin check', () => {
    const origin = window.location.origin;

    async function select(allowedOrigins?: string[] | null) {
      service.loadConfigurations.mockResolvedValue([{ id: 'pid', allowedOrigins }]);
      await choose({ requestId: 'pid', dcapi: true });
    }

    it('names the missing origin and blocks the request', async () => {
      service.loadConfigurations.mockResolvedValue([
        { id: 'pid', allowedOrigins: ['https://other.example'] },
      ]);
      const open = vi.spyOn(fixture.debugElement.injector.get(MatSnackBar), 'open');
      await choose({ requestId: 'pid', dcapi: true });
      fixture.debugElement.injector.get(ChangeDetectorRef).markForCheck();
      fixture.detectChanges();

      const message = fixture.nativeElement.querySelector('#dc-api-origin-problem');
      expect(message?.textContent).toContain(origin);
      const toggle = fixture.nativeElement.querySelector('button[role="switch"]');
      expect(toggle.getAttribute('aria-describedby')).toContain('dc-api-origin-problem');
      expectUnavailable(fixture, generateButton(), component.dcApiOriginProblem!);
      const checks = service.checkPresentationReadiness.mock.calls.length;

      // Enter in a field submits without showing the tooltip.
      await component.onSubmit();

      expect(open).toHaveBeenLastCalledWith(
        component.dcApiOriginProblem,
        'Close',
        expect.anything()
      );
      // The origin problem stays whatever a new readiness check says.
      expect(service.checkPresentationReadiness).toHaveBeenCalledTimes(checks);
      expect(service.getOffer).not.toHaveBeenCalled();
    });

    it('accepts a configuration without allowed origins and names this page', async () => {
      await select(null);
      expect(component.dcApiOriginProblem).toBeNull();

      await component.onSubmit();
      expect(service.getOffer).toHaveBeenCalledWith(
        expect.objectContaining({ response_type: 'dc-api', expected_origin: origin })
      );
    });

    it('allows a configuration that lists this page', async () => {
      await select([origin]);
      expect(component.dcApiOriginProblem).toBeNull();

      await component.onSubmit();
      expect(service.getOffer).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: 'pid',
          response_type: 'dc-api',
          expected_origin: origin,
        })
      );
    });

    it('does not check uri requests', async () => {
      await select(null);
      component.form.patchValue({ dcapi: false });
      expect(component.dcApiOriginProblem).toBeNull();
    });
  });

  it('requests an x509_san_dns client ID when selected', async () => {
    await choose({ requestId: 'pid-verification', clientIdScheme: 'x509_san_dns' });

    await component.onSubmit();

    expect(service.getOffer).toHaveBeenCalledWith({
      requestId: 'pid-verification',
      response_type: 'uri',
      clientIdScheme: 'x509_san_dns',
    });
  });

  it('requests an openid_federation client ID when selected', async () => {
    await choose({ requestId: 'pid-verification', clientIdScheme: 'openid_federation' });

    await component.onSubmit();

    expect(service.getOffer).toHaveBeenCalledWith({
      requestId: 'pid-verification',
      response_type: 'uri',
      clientIdScheme: 'openid_federation',
    });
  });

  it('sends no client ID scheme for the default certificate hash', async () => {
    await choose({ requestId: 'pid-verification' });

    await component.onSubmit();

    expect(service.getOffer).toHaveBeenCalledWith({
      requestId: 'pid-verification',
      response_type: 'uri',
    });
  });

  it('shows the reason the backend gives for a failed request', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // The component's own injector provides the snack bar it uses.
    const open = vi.spyOn(fixture.debugElement.injector.get(MatSnackBar), 'open');
    service.getOffer.mockRejectedValue({
      message: "No key chain found with usage type 'access' for tenant demo",
    });
    await choose({ requestId: 'pid-verification' });

    await component.onSubmit();

    expect(open).toHaveBeenCalledWith(
      "Failed to generate verification request: No key chain found with usage type 'access' for tenant demo",
      'Close',
      expect.anything()
    );
  });
});
