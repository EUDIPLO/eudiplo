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
      expect(fixture.nativeElement.textContent).toContain(
        'Please select a presentation configuration'
      );
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
      expectUnavailable(fixture, generate, 'Generating the presentation request…');
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

      expectUnavailable(
        fixture,
        generateButton(),
        'The presentation configurations could not be loaded.'
      );
    });

    it('generates the request of a configuration the page was opened for', async () => {
      TestBed.inject(ActivatedRoute).snapshot.params['id'] = 'pid';
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
      fixture.detectChanges();
      await fixture.whenStable();

      await vi.waitFor(() =>
        expect(service.getOffer).toHaveBeenCalledWith({ requestId: 'pid', response_type: 'uri' })
      );
      expect(service.getOffer).toHaveBeenCalledOnce();
      expect(navigate).toHaveBeenCalledWith(['/session-management', 'session-id']);
    });

    it('says why it cannot be used when there is no configuration', async () => {
      service.loadConfigurations.mockResolvedValue([]);
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
      expectUnavailable(
        fixture,
        generateButton(),
        'There is no presentation configuration to request.'
      );

      await component.onSubmit();

      expect(open).toHaveBeenLastCalledWith(
        'There is no presentation configuration to request.',
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
      "Failed to generate presentation request: No key chain found with usage type 'access' for tenant demo",
      'Close',
      expect.anything()
    );
  });
});
