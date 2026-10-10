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

  it('requests an x509_san_dns client ID when selected', async () => {
    component.form.patchValue({
      requestId: 'pid-verification',
      x509SanDns: true,
    });

    await component.onSubmit();

    expect(service.getOffer).toHaveBeenCalledWith({
      requestId: 'pid-verification',
      response_type: 'uri',
      clientIdScheme: 'x509_san_dns',
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
