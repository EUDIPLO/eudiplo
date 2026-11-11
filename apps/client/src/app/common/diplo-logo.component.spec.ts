import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { DiploLogoComponent } from './diplo-logo.component';

describe('DiploLogoComponent', () => {
  it('is hidden from assistive technology', () => {
    const fixture = TestBed.createComponent(DiploLogoComponent);
    fixture.detectChanges();

    const svg = (fixture.nativeElement as HTMLElement).querySelector('svg');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.hasAttribute('role')).toBe(false);
  });

  it('renders the body and fold paths that the theme colours by class', () => {
    const fixture = TestBed.createComponent(DiploLogoComponent);
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('path.body')?.getAttribute('d')).toBeTruthy();
    expect(element.querySelector('path.fold')?.getAttribute('d')).toBeTruthy();
  });
});
