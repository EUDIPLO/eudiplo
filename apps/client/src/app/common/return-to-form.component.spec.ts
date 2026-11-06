import { LiveAnnouncer } from '@angular/cdk/a11y';
import { TestBed } from '@angular/core/testing';
import { convertToParamMap, provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fromFormQueryParams, openedFromForm } from './return-to-form';
import { ReturnToFormComponent } from './return-to-form.component';

describe('fromFormQueryParams and openedFromForm', () => {
  it("adds the marker to a link's own query parameters", () => {
    expect(fromFormQueryParams({ usage: 'trustList' })).toEqual({
      usage: 'trustList',
      from: 'form',
    });
    expect(fromFormQueryParams({})).toEqual({ from: 'form' });
  });

  it('recognizes only a page opened with the marker', () => {
    expect(openedFromForm(convertToParamMap(fromFormQueryParams({ usage: 'x' })))).toBe(true);
    expect(openedFromForm(convertToParamMap({ usage: 'x' }))).toBe(false);
    expect(openedFromForm(convertToParamMap({ from: 'elsewhere' }))).toBe(false);
  });
});

describe('ReturnToFormComponent', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
  });

  function render() {
    const fixture = TestBed.createComponent(ReturnToFormComponent);
    fixture.componentRef.setInput('heading', 'Key chain "Tokens" created');
    fixture.componentRef.setInput('link', ['/keys', 'key-1']);
    fixture.componentRef.setInput('linkLabel', 'Open key chain');
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('says to return to the tab with the form and links the new item', () => {
    const element = render();

    expect(element.querySelector('h3')?.textContent?.trim()).toBe('Key chain "Tokens" created');
    expect(element.textContent).toContain('Your form is still open in the tab you came from.');
    const link = element.querySelector('a')!;
    expect(link.textContent?.trim()).toBe('Open key chain');
    expect(link.getAttribute('href')).toBe('/keys/key-1');
    expect(link.getAttribute('target')).toBeNull();
  });

  it('takes the focus the replaced form had, else announces the card', () => {
    const announce = vi.spyOn(TestBed.inject(LiveAnnouncer), 'announce').mockResolvedValue();
    (document.activeElement as HTMLElement | null)?.blur();
    const first = render();
    expect(document.activeElement).toBe(first.querySelector('h3'));
    expect(announce).not.toHaveBeenCalled();

    const input = document.body.appendChild(document.createElement('input'));
    input.focus();
    render();
    expect(document.activeElement).toBe(input);
    expect(announce).toHaveBeenCalledWith(
      'Key chain "Tokens" created. Your form is still open in the tab you came from. Continue there; you can close this tab.'
    );
    input.remove();
  });
});
