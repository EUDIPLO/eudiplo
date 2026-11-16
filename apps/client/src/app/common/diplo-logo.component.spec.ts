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

  it('gives each instance its own clip path', () => {
    const first = TestBed.createComponent(DiploLogoComponent);
    const second = TestBed.createComponent(DiploLogoComponent);
    first.detectChanges();
    second.detectChanges();

    const idOf = (fixture: typeof first) =>
      (fixture.nativeElement as HTMLElement).querySelector('clipPath')?.getAttribute('id');
    expect(idOf(first)).toBeTruthy();
    expect(idOf(first)).not.toBe(idOf(second));
    expect((first.nativeElement as HTMLElement).querySelector('g')?.getAttribute('clip-path')).toBe(
      `url(#${idOf(first)})`
    );
  });

  it('closes its eyes only when asked', () => {
    const fixture = TestBed.createComponent(DiploLogoComponent);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.classList.contains('eyes-closed')).toBe(false);

    fixture.componentRef.setInput('eyesClosed', true);
    fixture.detectChanges();
    expect(host.classList.contains('eyes-closed')).toBe(true);
  });
});
