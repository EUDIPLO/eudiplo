import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';

import { JwtService } from '../../services/jwt.service';
import { UserCreateComponent } from './user-create.component';

describe('UserCreateComponent back button', () => {
  async function backLabel(params: Record<string, string>): Promise<string | null> {
    await TestBed.configureTestingModule({
      imports: [UserCreateComponent],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap(params) } },
        },
        {
          provide: JwtService,
          useValue: { getRoles: () => ['users:manage'], grantHint: () => '' },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(UserCreateComponent);
    fixture.detectChanges();
    const back = [...(fixture.nativeElement as HTMLElement).querySelectorAll('button')].find(
      (button) => button.querySelector('mat-icon')?.textContent?.trim() === 'arrow_back'
    );
    return back?.getAttribute('aria-label') ?? null;
  }

  it('names the users list it leads to when creating a user', async () => {
    expect(await backLabel({})).toBe('Back to Users List');
  });

  it('names the user page it leads to when editing a user', async () => {
    expect(await backLabel({ id: 'alice' })).toBe('Back to User Details');
  });
});
