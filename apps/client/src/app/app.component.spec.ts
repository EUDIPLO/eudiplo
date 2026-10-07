import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppComponent } from './app.component';
import { JwtService, type Role } from './services/jwt.service';

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

describe('AppComponent navigation', () => {
  function menuItems(roles: Role[]): string[] {
    TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [
        provideRouter([]),
        {
          provide: JwtService,
          useValue: {
            hasRole: (role: Role | Role[]) =>
              (Array.isArray(role) ? role : [role]).some((r) => roles.includes(r)),
            hasTenantContext: () => true,
          },
        },
      ],
    });
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    return Array.from(
      element.querySelectorAll('mat-sidenav [matListItemTitle]'),
      (item) => item.textContent?.trim() ?? ''
    );
  }

  it.each<[string, Role[]]>([
    ['issuance', ['issuance:manage', 'issuance:offer']],
    ['verification', ['presentation:manage', 'presentation:request']],
    ['issuance and verification', ['issuance:manage', 'presentation:manage']],
  ])('lists Webhook Endpoints once for %s admins', (_, roles) => {
    expect(menuItems(roles).filter((item) => item === 'Webhook Endpoints')).toHaveLength(1);
  });

  it('hides Webhook Endpoints from clients that cannot manage them', () => {
    expect(menuItems(['issuance:offer', 'presentation:request'])).not.toContain(
      'Webhook Endpoints'
    );
  });
});
