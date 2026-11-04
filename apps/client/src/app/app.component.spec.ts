import { BreakpointObserver } from '@angular/cdk/layout';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MATERIAL_ANIMATIONS } from '@angular/material/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { By } from '@angular/platform-browser';
import { provideRouter, Router, RouterLink } from '@angular/router';
import { NEVER, of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppComponent } from './app.component';
import { ApiService } from './core';
import { JwtService, roles as allRoles, type Role } from './services/jwt.service';
import {
  NAV_SECTION_ROUTES,
  NavSectionsService,
  type NavSection,
} from './services/nav-sections.service';

describe('AppComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AppComponent],
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });
});

@Component({ template: '' })
class EmptyPageComponent {}

describe('AppComponent navigation', () => {
  function renderNav(roles: Role[]): HTMLElement {
    TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [
        provideRouter([{ path: '**', component: EmptyPageComponent }]),
        {
          provide: JwtService,
          useValue: {
            hasRole: (role: Role | Role[]) =>
              (Array.isArray(role) ? role : [role]).some((r) => roles.includes(r)),
            hasTenantContext: () => true,
            canUseConfigPortability: JwtService.prototype.canUseConfigPortability,
            getCaller: () => undefined,
          },
        },
      ],
    });
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  function menuItems(roles: Role[]): string[] {
    return Array.from(
      renderNav(roles).querySelectorAll('mat-sidenav [matListItemTitle]'),
      (item) => item.textContent?.trim() ?? ''
    );
  }

  // RouterLink only listens for click; on an anchor the browser turns Enter into one.
  it('renders every entry as a link, so Enter opens it', () => {
    const element = renderNav(allRoles);
    const entries = Array.from(element.querySelectorAll('mat-sidenav .mat-mdc-list-item'));
    expect(entries.length).toBeGreaterThan(0);
    expect(entries).toHaveLength(element.querySelectorAll('mat-sidenav [matListItemTitle]').length);
    for (const entry of entries) {
      expect(entry.tagName).toBe('A');
      expect(entry.getAttribute('href')).toMatch(/^\//);
    }
  });

  it('marks only the entry of the open page as the current page', async () => {
    const element = renderNav(allRoles);
    const router = TestBed.inject(Router);
    const entries = Array.from(element.querySelectorAll('mat-sidenav a.mat-mdc-list-item'));
    expect(entries.length).toBeGreaterThan(0);

    for (const entry of entries) {
      const href = entry.getAttribute('href')!;
      await router.navigateByUrl(href);

      // RouterLinkActive sets aria-current in a microtask after the navigation.
      await vi.waitFor(() => {
        const current = element.querySelectorAll('mat-sidenav [aria-current="page"]');
        expect(current, href).toHaveLength(1);
        expect(current[0], href).toBe(entry);
      });
    }
  });

  it.each<[string, Role[]]>([
    ['issuance', ['issuance:manage', 'issuance:offer']],
    ['verification', ['presentation:manage', 'presentation:request']],
    ['issuance and verification', ['issuance:manage', 'presentation:manage']],
  ])('lists Webhook Endpoints once for %s admins', (_, roles) => {
    expect(menuItems(roles).filter((item) => item === 'Webhook Endpoints')).toHaveLength(1);
  });

  // Matches the route guard in app.routes.ts and the backend trust list controller.
  it.each<[string, Role[]]>([
    ['issuance', ['issuance:manage', 'issuance:offer']],
    ['verification', ['presentation:manage', 'presentation:request']],
    ['issuance and verification', ['issuance:manage', 'presentation:manage']],
  ])('lists Trust Lists once for %s admins', (_, roles) => {
    expect(menuItems(roles).filter((item) => item === 'Trust Lists')).toHaveLength(1);
  });

  it('shows Config Portability only with tenant:admin or tenants:manage', () => {
    expect(menuItems(['tenant:admin'])).toContain('Config Portability');
    TestBed.resetTestingModule();
    expect(menuItems(['issuance:manage', 'presentation:manage'])).not.toContain(
      'Config Portability'
    );
  });

  // Matches the route guard in session-management.routes.ts and the backend session controllers.
  it.each<[Role[], string[]]>([
    [['issuance:manage'], ['Session Settings']],
    [['presentation:manage'], ['Session Settings']],
    [['issuance:offer'], ['All Sessions']],
    [
      ['presentation:request', 'presentation:manage'],
      ['All Sessions', 'Session Settings'],
    ],
  ])('lists the session entries for %j', (roles, entries) => {
    expect(
      menuItems(roles).filter((item) => ['All Sessions', 'Session Settings'].includes(item))
    ).toEqual(entries);
  });

  it.each<[Role[], boolean]>([
    [['presentation:manage'], true],
    [['clients:manage'], false],
  ])('shows the Sessions header for %j: %s', (roles, shown) => {
    const header = renderNav(roles).querySelector('button[aria-controls="nav-section-sessions"]');
    expect(header !== null).toBe(shown);
  });

  it.each(['Webhook Endpoints', 'Trust Lists'])(
    'hides %s from clients that cannot manage them',
    (entry) => {
      expect(menuItems(['issuance:offer', 'presentation:request'])).not.toContain(entry);
    }
  );
});

describe('AppComponent session expiry', () => {
  it('warns on any page before a token without refresh expires', async () => {
    const open = vi.fn<(message: string, action: string) => object>(() => ({
      onAction: () => NEVER,
      afterDismissed: () => NEVER,
    }));
    TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [
        provideRouter([]),
        { provide: MatSnackBar, useValue: { open } },
        {
          provide: ApiService,
          useValue: {
            accessToken: 'token',
            getAuthenticationStatus: () => true,
            getTokenTimeRemaining: () => 4 * 60_000,
            canRefreshToken: () => false,
            getBaseUrl: () => undefined,
            getClientId: () => undefined,
            tokenRenewed$: NEVER,
            sessionEnded$: NEVER,
          },
        },
      ],
    });
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();

    await vi.waitFor(() => expect(open).toHaveBeenCalled());
    expect(open.mock.calls[0][0]).toBe('Your session expires in 4 minutes. Save your work.');
    fixture.destroy();
  });
});

describe('AppComponent help menu', () => {
  function helpLinks(baseUrl: string | undefined): { text: string; href: string | null }[] {
    TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [
        provideRouter([]),
        {
          provide: ApiService,
          useValue: {
            accessToken: '',
            getAuthenticationStatus: () => false,
            getTokenTimeRemaining: () => 0,
            canRefreshToken: () => false,
            getBaseUrl: () => baseUrl,
            getClientId: () => undefined,
            tokenRenewed$: NEVER,
            sessionEnded$: NEVER,
          },
        },
      ],
    });
    const fixture = TestBed.createComponent(AppComponent);
    fixture.componentInstance.shouldShowToolbar = true;
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    (element.querySelector('button[aria-label="Help and resources"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    const links = Array.from(document.querySelectorAll('.mat-mdc-menu-panel a'), (link) => ({
      text: link.querySelector('span')?.textContent?.trim() ?? '',
      href: link.getAttribute('href'),
    }));
    fixture.destroy();
    return links;
  }

  it("links the instance's management API reference", () => {
    expect(helpLinks('https://eudiplo.example')).toContainEqual({
      text: 'API reference of this instance',
      href: 'https://eudiplo.example/api/docs',
    });
  });

  it('leaves the API reference out while no instance is configured', () => {
    expect(helpLinks(undefined).map((link) => link.text)).toEqual([
      'Documentation',
      'GitHub',
      'Discord community',
    ]);
  });
});

describe('AppComponent navigation toggle', () => {
  function render(handset: boolean) {
    TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [
        provideRouter([]),
        // jsdom fires no transitionend, so the drawer settles only without animations.
        { provide: MATERIAL_ANIMATIONS, useValue: { animationsDisabled: true } },
        {
          provide: BreakpointObserver,
          useValue: { observe: () => of({ matches: handset, breakpoints: {} }) },
        },
      ],
    });
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    const toggle = element.querySelector(
      'button[aria-label="Toggle navigation"]'
    ) as HTMLButtonElement;
    return { fixture, element, toggle };
  }

  it('names the menu button after the navigation it controls', () => {
    const { element, toggle } = render(false);

    expect(toggle.querySelector('mat-icon')?.textContent?.trim()).toBe('menu');
    expect(element.querySelector(`#${toggle.getAttribute('aria-controls')}`)?.tagName).toBe(
      'MAT-SIDENAV'
    );
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('reports whether the navigation is open on a phone', () => {
    const { fixture, toggle } = render(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    toggle.click();
    fixture.detectChanges();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    toggle.click();
    fixture.detectChanges();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('reports the navigation closed when the user taps the backdrop', async () => {
    const { fixture, element, toggle } = render(true);
    toggle.click();
    fixture.detectChanges();
    const backdrop = element.querySelector('.mat-drawer-backdrop') as HTMLElement;
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(backdrop.classList).toContain('mat-drawer-shown');
    });

    backdrop.click();

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
    });

    toggle.click();
    fixture.detectChanges();
    expect(backdrop.classList).toContain('mat-drawer-shown');
  });

  it('collapses and reopens the side-mode navigation', () => {
    const { fixture, element, toggle } = render(false);
    const sidenav = element.querySelector('mat-sidenav') as HTMLElement;

    toggle.click();
    fixture.detectChanges();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(sidenav.classList).not.toContain('mat-drawer-opened');

    toggle.click();
    fixture.detectChanges();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(sidenav.classList).toContain('mat-drawer-opened');
  });

  it('keeps the side-mode navigation open on Escape', async () => {
    const { fixture, element, toggle } = render(false);
    const sidenav = element.querySelector('mat-sidenav') as HTMLElement;

    sidenav.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27 }));
    await new Promise((resolve) => setTimeout(resolve));
    fixture.detectChanges();

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(sidenav.classList).toContain('mat-drawer-opened');
  });
});

describe('AppComponent skip link', () => {
  function render() {
    TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [provideRouter([{ path: 'login', component: EmptyPageComponent }])],
    });
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    return { fixture, element: fixture.nativeElement as HTMLElement };
  }

  it('is the first focusable element and moves focus to the main content', () => {
    const { element } = render();
    const link = element.querySelector('a, button, [tabindex="0"]') as HTMLAnchorElement;
    expect(link.textContent?.trim()).toBe('Skip to main content');

    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(click);

    expect(click.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(element.querySelector('#main-content'));
  });

  it('is left out on the login page', async () => {
    const { fixture, element } = render();
    await TestBed.inject(Router).navigateByUrl('/login');
    fixture.detectChanges();

    expect(element.querySelector('.skip-link')).toBeNull();
  });
});

describe('AppComponent collapsible navigation', () => {
  function render(
    hasRole: (role: Role | Role[]) => boolean = (role) => [role].flat().includes('issuance:manage')
  ) {
    localStorage.clear();
    TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [
        provideRouter([
          { path: 'credential-config', component: EmptyPageComponent },
          { path: 'old-credential-config', redirectTo: 'credential-config' },
          { path: 'dashboard', component: EmptyPageComponent },
        ]),
        {
          provide: JwtService,
          useValue: {
            hasRole,
            hasTenantContext: () => true,
            canUseConfigPortability: JwtService.prototype.canUseConfigPortability,
            getCaller: () => undefined,
          },
        },
      ],
    });
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    const header = () =>
      element.querySelector('button[aria-controls="nav-section-issuance"]') as HTMLButtonElement;
    const group = () => element.querySelector('#nav-section-issuance') as HTMLElement;
    return { fixture, element, header, group };
  }

  it('collapses and expands a section from its header', () => {
    const { fixture, header, group } = render();
    expect(header().getAttribute('aria-expanded')).toBe('true');
    expect(group().hidden).toBe(false);

    header().click();
    fixture.detectChanges();

    expect(header().getAttribute('aria-expanded')).toBe('false');
    expect(group().hidden).toBe(true);
    expect(group().textContent).toContain('Credential Types');

    header().click();
    fixture.detectChanges();

    expect(header().getAttribute('aria-expanded')).toBe('true');
    expect(group().hidden).toBe(false);
  });

  it('opens a collapsed section when the user navigates to one of its pages', async () => {
    const { fixture, group } = render();
    TestBed.inject(NavSectionsService).toggle('issuance');
    fixture.detectChanges();
    expect(group().hidden).toBe(true);

    await TestBed.inject(Router).navigateByUrl('/credential-config');
    fixture.detectChanges();

    expect(group().hidden).toBe(false);
  });

  it('opens the section of the page a redirect leads to', async () => {
    const { fixture, group } = render();
    TestBed.inject(NavSectionsService).toggle('issuance');

    await TestBed.inject(Router).navigateByUrl('/old-credential-config');
    fixture.detectChanges();

    expect(group().hidden).toBe(false);
  });

  it('keeps a collapse while the user filters the page of the same section', async () => {
    const { fixture, header, group } = render();
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/credential-config');
    header().click();

    await router.navigateByUrl('/credential-config?q=pid');
    fixture.detectChanges();

    expect(group().hidden).toBe(true);
  });

  it('opens each section for every page it links to', () => {
    const { fixture, element } = render(() => true);
    const router = TestBed.inject(Router);
    const sections = TestBed.inject(NavSectionsService);

    for (const section of Object.keys(NAV_SECTION_ROUTES) as NavSection[]) {
      const group = fixture.debugElement.query(By.css(`#nav-section-${section}`));
      expect(group, section).not.toBeNull();
      expect(
        element.querySelector(`button[aria-controls="nav-section-${section}"]`)
      ).not.toBeNull();
      const links = group
        .queryAll(By.directive(RouterLink))
        .map((link) => router.serializeUrl(link.injector.get(RouterLink).urlTree!));
      expect(links.length, section).toBeGreaterThan(0);
      for (const link of links) expect(sections.sectionOf(link), link).toBe(section);
    }
  });
});
