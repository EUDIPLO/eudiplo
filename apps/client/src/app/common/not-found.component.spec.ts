import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { describe, expect, it } from 'vitest';

import { NotFoundComponent } from './not-found.component';

describe('NotFoundComponent', () => {
  it('names the address without its query, also the next unknown one, and links to the dashboard', async () => {
    TestBed.configureTestingModule({
      providers: [provideRouter([{ path: '**', component: NotFoundComponent }])],
    });
    const harness = await RouterTestingHarness.create('/registrar/old-page?token=abc');
    const element = harness.routeNativeElement!;

    expect(element.querySelector('h1')?.textContent).toBe('Page not found');
    expect(element.querySelector('.address')?.textContent).toBe('/registrar/old-page');
    expect(element.querySelector('a')?.getAttribute('href')).toBe('/dashboard');

    // The router reuses the page for another address that no route matches.
    await harness.navigateByUrl('/schema-catalog#top');

    expect(harness.routeNativeElement!.querySelector('.address')?.textContent).toBe(
      '/schema-catalog'
    );
  });
});
