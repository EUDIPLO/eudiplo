import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import { unsavedChangesGuard } from '../guards/unsaved-changes.guard';
import {
  type PageWithUnsavedChanges,
  UNSAVED_CHANGES_QUESTION,
  UnsavedChangesService,
} from './unsaved-changes.service';

@Component({ template: '' })
class FormPage implements PageWithUnsavedChanges {
  static dirty = false;
  hasUnsavedChanges(): boolean {
    return FormPage.dirty;
  }
}

@Component({ template: '' })
class OtherPage {}

describe('UnsavedChangesService', () => {
  let service: UnsavedChangesService;
  let router: Router;
  let confirm: MockInstance<typeof globalThis.confirm>;

  const unload = (): BeforeUnloadEvent => {
    const event = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
    globalThis.dispatchEvent(event);
    return event;
  };

  beforeEach(() => {
    FormPage.dirty = false;
    confirm = vi.spyOn(globalThis, 'confirm').mockReturnValue(false);
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'form', component: FormPage, canDeactivate: [unsavedChangesGuard] },
          { path: 'other', component: OtherPage },
          { path: 'blocked', component: OtherPage, canActivate: [() => false] },
        ]),
      ],
    });
    service = TestBed.inject(UnsavedChangesService);
    router = TestBed.inject(Router);
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
  });

  it('lets a page without unsaved changes go without asking', () => {
    expect(service.confirmLeave(new OtherPage())).toBe(true);
    FormPage.dirty = false;
    expect(service.confirmLeave(new FormPage())).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('asks before leaving unsaved changes and keeps the page when the user declines', () => {
    FormPage.dirty = true;
    expect(service.confirmLeave(new FormPage())).toBe(false);
    expect(confirm).toHaveBeenCalledWith(UNSAVED_CHANGES_QUESTION);
  });

  it("asks the page's own question", () => {
    const page: PageWithUnsavedChanges = {
      hasUnsavedChanges: () => true,
      leaveQuestion: () => 'Leave the secrets?',
    };
    service.confirmLeave(page);
    expect(confirm).toHaveBeenCalledWith('Leave the secrets?');
  });

  it('blocks a navigation away from a page with unsaved changes until the user agrees', async () => {
    await RouterTestingHarness.create('/form');
    FormPage.dirty = true;

    expect(await router.navigateByUrl('/other')).toBe(false);
    expect(router.url).toBe('/form');

    confirm.mockReturnValue(true);
    expect(await router.navigateByUrl('/other')).toBe(true);
    expect(router.url).toBe('/other');
  });

  it('asks again once another guard has stopped the navigation it agreed to', async () => {
    service.shown({ hasUnsavedChanges: () => true });
    confirm.mockReturnValue(true);
    expect(service.confirmLeave()).toBe(true);
    // Agreed once, so the navigation that follows does not ask again.
    expect(service.confirmLeave()).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);

    // The page stays shown: only the cancelled navigation takes the agreement back.
    expect(await router.navigateByUrl('/blocked')).toBe(false);
    expect(service.confirmLeave()).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('has the browser ask before a reload while the shown page has unsaved changes', () => {
    const page = new FormPage();
    service.shown(page);
    expect(unload().defaultPrevented).toBe(false);

    FormPage.dirty = true;
    expect(unload().defaultPrevented).toBe(true);

    service.hidden(page);
    expect(unload().defaultPrevented).toBe(false);
  });

  it('keeps the shown page when another page is hidden', () => {
    FormPage.dirty = true;
    service.shown(new FormPage());
    service.hidden(new OtherPage());
    expect(unload().defaultPrevented).toBe(true);
  });

  it('lets the page unload after the user agreed to leave it', () => {
    FormPage.dirty = true;
    service.shown(new FormPage());
    confirm.mockReturnValue(true);
    expect(service.confirmLeave()).toBe(true);
    expect(unload().defaultPrevented).toBe(false);
  });
});
