import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { client } from '@eudiplo/sdk-core';
import { vi } from 'vitest';

import { ApiService } from '../../core';
import { CredentialConfigService } from '../../issuance/credential-config/credential-config.service';
import { FrontendConfigService } from '../../services/frontend-config.service';
import { TrustListShowComponent } from './trust-list-show.component';

describe('TrustListShowComponent', () => {
  let component: TrustListShowComponent;
  let fixture: ComponentFixture<TrustListShowComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TrustListShowComponent],
      providers: [provideRouter([])],
    }).compileComponents();

    fixture = TestBed.createComponent(TrustListShowComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});

describe('TrustListShowComponent public URL', () => {
  const trustList = {
    id: 'membership-issuers',
    tenantId: 'membership-demo',
    description: 'Issuers accepted for membership checks',
    entityConfig: [],
  };

  async function render(publicUrl: string | undefined) {
    client.setConfig({
      fetch: async (request: RequestInfo | URL) => {
        const path = new URL(request instanceof Request ? request.url : String(request)).pathname;
        const body = path.endsWith('/versions') ? [] : trustList;
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    await TestBed.configureTestingModule({
      imports: [TrustListShowComponent],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ id: trustList.id }) } },
        },
        // The admin signed in with the Compose-internal address.
        { provide: ApiService, useValue: { getBaseUrl: () => 'http://eudiplo:3000' } },
        {
          provide: FrontendConfigService,
          useValue: { getConfig: async () => ({ configImportMode: 'disabled', publicUrl }) },
        },
        { provide: CredentialConfigService, useValue: { loadConfigurations: async () => [] } },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(TrustListShowComponent);
    fixture.detectChanges();
    await vi.waitFor(() => expect(fixture.componentInstance.publicUrl).not.toBe(''));
    fixture.detectChanges();
    return fixture;
  }

  function shownUrl(fixture: ComponentFixture<TrustListShowComponent>): string | undefined {
    const element = fixture.nativeElement as HTMLElement;
    return element.querySelector<HTMLInputElement>('.public-url-section input')?.value;
  }

  afterEach(() => {
    client.setConfig({ fetch: () => new Promise<Response>(() => undefined) });
  });

  it('shows the URL under the public URL of the backend, not the instance URL', async () => {
    const fixture = await render('https://eudiplo.example.com');

    expect(shownUrl(fixture)).toBe(
      'https://eudiplo.example.com/issuers/membership-demo/trust-list/membership-issuers'
    );
    expect(fixture.nativeElement.textContent).not.toContain('did not report its public URL');
  });

  it('falls back to the instance URL with a warning when the backend reports no public URL', async () => {
    const fixture = await render(undefined);

    expect(shownUrl(fixture)).toBe(
      'http://eudiplo:3000/issuers/membership-demo/trust-list/membership-issuers'
    );
    expect(fixture.nativeElement.textContent).toContain('did not report its public URL');
  });
});
