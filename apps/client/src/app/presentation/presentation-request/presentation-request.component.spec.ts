import { ChangeDetectorRef } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PresentationRequestComponent } from './presentation-request.component';
import { PresentationManagementService } from '../presentation-config/presentation-management.service';

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
      loadConfigurations: vi.fn().mockResolvedValue([]),
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

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  describe('DC API origin check', () => {
    const origin = window.location.origin;

    function select(allowedOrigins?: string[] | null) {
      component.configs = [{ id: 'pid', allowedOrigins } as any];
      component.form.patchValue({ requestId: 'pid', dcapi: true });
    }

    it('names the missing origin and blocks the request', async () => {
      service.loadConfigurations.mockResolvedValue([
        { id: 'pid', allowedOrigins: ['https://other.example'] },
      ]);
      fixture.detectChanges();
      await fixture.whenStable();
      component.form.patchValue({ requestId: 'pid', dcapi: true });
      fixture.debugElement.injector.get(ChangeDetectorRef).markForCheck();
      fixture.detectChanges();

      const message = fixture.nativeElement.querySelector('#dc-api-origin-problem');
      expect(message?.textContent).toContain(origin);
      const toggle = fixture.nativeElement.querySelector('button[role="switch"]');
      expect(toggle.getAttribute('aria-describedby')).toContain('dc-api-origin-problem');

      await component.onSubmit();
      expect(service.getOffer).not.toHaveBeenCalled();
    });

    it('accepts a configuration without allowed origins and names this page', async () => {
      select(null);
      expect(component.dcApiOriginProblem).toBeNull();

      await component.onSubmit();
      expect(service.getOffer).toHaveBeenCalledWith(
        expect.objectContaining({ response_type: 'dc-api', expected_origin: origin })
      );
    });

    it('allows a configuration that lists this page', async () => {
      select([origin]);
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

    it('does not check uri requests', () => {
      select(null);
      component.form.patchValue({ dcapi: false });
      expect(component.dcApiOriginProblem).toBeNull();
    });
  });

  it('requests an x509_san_dns client ID when selected', async () => {
    component.form.patchValue({
      requestId: 'pid-verification',
      clientIdScheme: 'x509_san_dns',
    });

    await component.onSubmit();

    expect(service.getOffer).toHaveBeenCalledWith({
      requestId: 'pid-verification',
      response_type: 'uri',
      clientIdScheme: 'x509_san_dns',
    });
  });

  it('requests an openid_federation client ID when selected', async () => {
    component.form.patchValue({
      requestId: 'pid-verification',
      clientIdScheme: 'openid_federation',
    });

    await component.onSubmit();

    expect(service.getOffer).toHaveBeenCalledWith({
      requestId: 'pid-verification',
      response_type: 'uri',
      clientIdScheme: 'openid_federation',
    });
  });

  it('sends no client ID scheme for the default certificate hash', async () => {
    component.form.patchValue({ requestId: 'pid-verification' });

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
    component.form.patchValue({ requestId: 'pid-verification' });

    await component.onSubmit();

    expect(open).toHaveBeenCalledWith(
      "Failed to generate presentation request: No key chain found with usage type 'access' for tenant demo",
      'Close',
      expect.anything()
    );
  });
});
