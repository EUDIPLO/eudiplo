import { ChangeDetectorRef, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltip, MatTooltipModule } from '@angular/material/tooltip';
import { By } from '@angular/platform-browser';
import { provideRouter, Router, RouterLink } from '@angular/router';
import { vi } from 'vitest';

import { ConfigOwnershipDirective } from './config-ownership.directive';
import { ConfigOwnershipService, ConfigResourceOwnership } from './config-ownership.service';

@Component({
  imports: [ConfigOwnershipDirective, FormsModule, MatButtonModule, MatTooltipModule, RouterLink],
  template: `<button
      class="delete"
      mat-button
      appConfigManaged
      managedKind="PresentationConfig"
      [managedResourceId]="id()"
      (click)="clicked = clicked + 1"
    >
      Delete
    </button>
    <button
      class="edit"
      matIconButton
      routerLink="/edit"
      [matTooltip]="editTooltip()"
      appConfigManaged
      managedKind="PresentationConfig"
      [managedResourceId]="id()"
    >
      <span aria-hidden="true">✎</span>
    </button>
    <button
      class="save"
      mat-raised-button
      [disabled]="disabled()"
      appConfigManaged
      managedKind="PresentationConfig"
      [managedResourceId]="id()"
    >
      Save
    </button>
    <button
      class="reset"
      mat-button
      [disabled]="nothingToReset()"
      disabledInteractive
      appConfigManaged
      managedKind="PresentationConfig"
      [managedResourceId]="id()"
    >
      Reset
    </button>
    <button
      class="plain"
      type="button"
      appConfigManaged
      managedKind="PresentationConfig"
      [managedResourceId]="id()"
    >
      Plain
    </button>
    <form (ngSubmit)="submitted = submitted + 1">
      <button
        class="submit"
        type="submit"
        mat-flat-button
        appConfigManaged
        managedKind="PresentationConfig"
        [managedResourceId]="id()"
      >
        Save
      </button>
    </form>
    <a
      class="setup"
      mat-stroked-button
      routerLink="/setup"
      appConfigManaged
      managedKind="PresentationConfig"
      [managedResourceId]="id()"
      >Use guided setup</a
    >`,
})
class HostComponent {
  readonly id = signal('pid');
  readonly editTooltip = signal('Edit Configuration');
  /** Disabled for a reason of the screen's own, like an invalid form. */
  readonly disabled = signal(false);
  /** Disabled for a reason of the screen's own that its tooltip explains. */
  readonly nothingToReset = signal(true);
  clicked = 0;
  submitted = 0;
}

@Component({
  imports: [ConfigOwnershipDirective, MatButtonModule],
  template: `<button mat-button appConfigManaged managedKind="Tenant" managedResourceId="tenant">
    Use as default
  </button>`,
})
class TenantHostComponent {}

interface Lookup {
  id: string;
  resolve: (ownership: ConfigResourceOwnership | undefined) => void;
  reject: (error: unknown) => void;
}

const fileManaged: ConfigResourceOwnership = {
  kind: 'PresentationConfig',
  resourceId: 'pid',
  ownership: 'file-managed',
  generation: 1,
  source: 'folder:/config/demo',
};

describe('ConfigOwnershipDirective', () => {
  /** One pending lookup per call of get, by resource ID. */
  let lookups: Lookup[];

  function render() {
    lookups = [];
    TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [
        provideRouter([]),
        {
          provide: ConfigOwnershipService,
          useValue: {
            get: vi.fn(
              (_kind: string, id: string) =>
                new Promise<ConfigResourceOwnership | undefined>((resolve, reject) =>
                  lookups.push({ id, resolve, reject })
                )
            ),
          },
        },
      ],
    });
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    const remove = element.querySelector('button.delete') as HTMLButtonElement;
    const edit = element.querySelector('button.edit') as HTMLButtonElement;
    const save = element.querySelector('button.save') as HTMLButtonElement;
    const setup = element.querySelector('a.setup') as HTMLAnchorElement;
    const submit = element.querySelector('button.submit') as HTMLButtonElement;
    const reset = element.querySelector('button.reset') as HTMLButtonElement;
    const plain = element.querySelector('button.plain') as HTMLButtonElement;
    const tooltip = fixture.debugElement.query(By.css('button.edit')).injector.get(MatTooltip);
    return { fixture, remove, edit, save, setup, submit, reset, plain, navigate, tooltip };
  }

  async function answer(
    fixture: ReturnType<typeof render>['fixture'],
    ownership: ConfigResourceOwnership | undefined
  ) {
    for (const lookup of lookups.splice(0)) lookup.resolve(ownership);
    await fixture.whenStable();
    fixture.detectChanges();
  }

  /** Re-renders the host after a change to a plain field or signal. */
  function rerender(fixture: ReturnType<typeof render>['fixture']) {
    fixture.debugElement.injector.get(ChangeDetectorRef).markForCheck();
    fixture.detectChanges();
  }

  it('holds clicks and navigation back while the lookup runs', () => {
    const { fixture, remove, edit, navigate } = render();

    expect(remove.getAttribute('aria-busy')).toBe('true');
    expect(remove.style.cursor).toBe('progress');
    remove.click();
    edit.click();
    expect(fixture.componentInstance.clicked).toBe(0);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('locks a file-managed resource, including its links', async () => {
    const { fixture, remove, edit, setup, navigate } = render();
    await answer(fixture, fileManaged);

    expect(remove.getAttribute('aria-busy')).toBeNull();
    expect(remove.getAttribute('aria-disabled')).toBe('true');
    expect(edit.getAttribute('aria-disabled')).toBe('true');
    expect(setup.getAttribute('aria-disabled')).toBe('true');
    remove.click();
    edit.click();
    setup.click();
    expect(fixture.componentInstance.clicked).toBe(0);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('keeps a locked submit button from submitting its form', async () => {
    const { fixture, submit } = render();
    await answer(fixture, fileManaged);

    // Enter and Space on the focused button, and Enter in a field, all click it.
    submit.click();
    expect(fixture.componentInstance.submitted).toBe(0);
  });

  it('keeps a locked action focusable and hoverable', async () => {
    const { fixture, edit } = render();
    await answer(fixture, fileManaged);

    expect(edit.hasAttribute('tabindex')).toBe(false);
    expect(edit.style.pointerEvents).toBe('');
    // Material's disabled look without `pointer-events: none`.
    expect(edit.classList).toContain('mat-mdc-button-disabled');
    expect(edit.classList).toContain('mat-mdc-button-disabled-interactive');
    expect(edit.tabIndex).toBe(0);
  });

  it('keeps a locked link from opening in a new tab', async () => {
    const { fixture, setup } = render();
    await answer(fixture, fileManaged);

    const middleClick = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 });
    const contextMenu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    setup.dispatchEvent(middleClick);
    setup.dispatchEvent(contextMenu);
    expect(middleClick.defaultPrevented).toBe(true);
    expect(contextMenu.defaultPrevented).toBe(true);
  });

  it('leaves the disabled look of an unlocked button to the button', async () => {
    const { fixture, save } = render();
    fixture.componentInstance.disabled.set(true);
    await answer(fixture, fileManaged);

    // Unlocking must not take Material's own disabled class with it.
    fixture.componentInstance.id.set('manual');
    rerender(fixture);
    await answer(fixture, undefined);
    expect(save.classList).not.toContain('config-managed-action');
    expect(save.classList).toContain('mat-mdc-button-disabled');
  });

  it('keeps a button disabled for another reason non-interactive when it is locked too', async () => {
    const { fixture, save } = render();
    fixture.componentInstance.disabled.set(true);
    await answer(fixture, fileManaged);

    expect(save.classList).toContain('mat-mdc-button-disabled');
    expect(save.classList).not.toContain('mat-mdc-button-disabled-interactive');
  });

  it("keeps a disabledInteractive button's aria-disabled while it is not locked", async () => {
    const { fixture, reset } = render();
    expect(reset.getAttribute('aria-disabled')).toBe('true');
    await answer(fixture, undefined);
    expect(reset.getAttribute('aria-disabled')).toBe('true');
    expect(reset.hasAttribute('disabled')).toBe(false);

    fixture.componentInstance.nothingToReset.set(false);
    rerender(fixture);
    expect(reset.getAttribute('aria-disabled')).toBeNull();

    fixture.componentInstance.nothingToReset.set(true);
    rerender(fixture);
    expect(reset.getAttribute('aria-disabled')).toBe('true');
  });

  it('keeps a locked disabledInteractive button aria-disabled when its own reason ends', async () => {
    const { fixture, reset } = render();
    await answer(fixture, fileManaged);
    expect(reset.getAttribute('aria-disabled')).toBe('true');

    fixture.componentInstance.nothingToReset.set(false);
    rerender(fixture);
    expect(reset.getAttribute('aria-disabled')).toBe('true');

    // Unlocking hands aria-disabled back to the button.
    fixture.componentInstance.id.set('manual');
    rerender(fixture);
    await answer(fixture, undefined);
    expect(reset.getAttribute('aria-disabled')).toBeNull();
    fixture.componentInstance.nothingToReset.set(true);
    rerender(fixture);
    expect(reset.getAttribute('aria-disabled')).toBe('true');
  });

  it('sets aria-disabled itself on a host that is not a Material button', async () => {
    const { fixture, plain } = render();
    await answer(fixture, fileManaged);
    expect(plain.getAttribute('aria-disabled')).toBe('true');

    fixture.componentInstance.id.set('manual');
    rerender(fixture);
    await answer(fixture, undefined);
    expect(plain.hasAttribute('aria-disabled')).toBe(false);
  });

  it('says why an action is locked and keeps its name', async () => {
    const { fixture, remove, edit, tooltip } = render();
    await answer(fixture, fileManaged);

    expect(remove.getAttribute('aria-description')).toBe(
      'Managed by folder:/config/demo, read-only'
    );
    expect(edit.getAttribute('aria-description')).toBe('Managed by folder:/config/demo, read-only');
    expect(tooltip.message).toBe('Edit Configuration. Managed by folder:/config/demo, read-only');
    // Without a Material tooltip, the browser's own shows the reason on hover.
    expect(remove.getAttribute('title')).toBe('Managed by folder:/config/demo, read-only');
    expect(edit.hasAttribute('title')).toBe(false);
  });

  it('follows the button when it is disabled and enabled again for another reason', async () => {
    const { fixture, save } = render();
    await answer(fixture, fileManaged);
    expect(save.classList).toContain('mat-mdc-button-disabled-interactive');

    fixture.componentInstance.disabled.set(true);
    rerender(fixture);
    expect(save.classList).not.toContain('mat-mdc-button-disabled-interactive');

    fixture.componentInstance.disabled.set(false);
    rerender(fixture);
    expect(save.classList).toContain('mat-mdc-button-disabled-interactive');
  });

  it('keeps the reason when the tooltip of a locked action changes', async () => {
    const { fixture, edit, tooltip } = render();
    await answer(fixture, fileManaged);

    fixture.componentInstance.editTooltip.set('Edit');
    rerender(fixture);
    expect(tooltip.message).toBe('Edit. Managed by folder:/config/demo, read-only');
    // A new tooltip is not a new resource, so it does not look up the ownership again.
    expect(lookups).toHaveLength(0);
    expect(edit.getAttribute('aria-busy')).toBeNull();
  });

  it('removes the lock and its reason when the resource changes to an unmanaged one', async () => {
    const { fixture, edit, tooltip } = render();
    await answer(fixture, fileManaged);

    fixture.componentInstance.id.set('manual');
    rerender(fixture);
    await answer(fixture, undefined);

    expect(tooltip.message).toBe('Edit Configuration');
    expect(edit.getAttribute('aria-description')).toBeNull();
    expect(edit.classList).not.toContain('config-managed-action');
    expect(edit.classList).not.toContain('mat-mdc-button-disabled');
  });

  it('gives only the reason when the tooltip of a locked action is empty', async () => {
    const { fixture, tooltip } = render();
    fixture.componentInstance.editTooltip.set('  ');
    await answer(fixture, fileManaged);

    expect(tooltip.message).toBe('Managed by folder:/config/demo, read-only');
  });

  it('removes the lock when the resource ID becomes empty, as on a create screen', async () => {
    const { fixture, edit, tooltip } = render();
    await answer(fixture, fileManaged);

    fixture.componentInstance.id.set('');
    rerender(fixture);

    expect(lookups).toHaveLength(0);
    expect(tooltip.message).toBe('Edit Configuration');
    expect(edit.getAttribute('aria-disabled')).toBeNull();
    expect(edit.getAttribute('aria-description')).toBeNull();
  });

  it('names a configuration bundle when the source is unknown', async () => {
    const { fixture, remove } = render();
    await answer(fixture, { ...fileManaged, source: undefined });

    expect(remove.getAttribute('aria-description')).toBe(
      'Managed by a configuration bundle, read-only'
    );
  });

  it('leaves an unmanaged resource editable', async () => {
    const { fixture, remove, edit, navigate, tooltip } = render();
    await answer(fixture, { ...fileManaged, ownership: 'unmanaged' });

    expect(remove.getAttribute('aria-disabled')).toBeNull();
    expect(remove.getAttribute('aria-description')).toBeNull();
    expect(remove.hasAttribute('title')).toBe(false);
    expect(remove.style.cursor).toBe('');
    expect(edit.classList).not.toContain('mat-mdc-button-disabled');
    expect(tooltip.message).toBe('Edit Configuration');
    remove.click();
    edit.click();
    expect(fixture.componentInstance.clicked).toBe(1);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('leaves a resource without ownership record editable', async () => {
    const { fixture, remove } = render();
    await answer(fixture, undefined);

    expect(remove.getAttribute('aria-disabled')).toBeNull();
    remove.click();
    expect(fixture.componentInstance.clicked).toBe(1);
  });

  it('ignores a late answer for a resource ID that has changed', async () => {
    const { fixture, remove } = render();
    const stale = lookups.splice(0);
    fixture.componentInstance.id.set('manual');
    fixture.detectChanges();

    for (const lookup of stale) lookup.resolve(fileManaged);
    await fixture.whenStable();
    // Re-render the host so any state the late answer left behind shows up.
    rerender(fixture);
    expect(remove.getAttribute('aria-busy')).toBe('true');
    expect(remove.getAttribute('aria-disabled')).toBeNull();

    expect(lookups.every((lookup) => lookup.id === 'manual')).toBe(true);
    await answer(fixture, undefined);
    expect(remove.getAttribute('aria-busy')).toBeNull();
    expect(remove.getAttribute('aria-disabled')).toBeNull();
  });

  it('leaves the action to the backend when the lookup fails', async () => {
    const { fixture, remove } = render();
    for (const lookup of lookups.splice(0)) lookup.reject({ statusCode: 403 });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(remove.getAttribute('aria-busy')).toBeNull();
    expect(remove.getAttribute('aria-disabled')).toBeNull();
    remove.click();
    expect(fixture.componentInstance.clicked).toBe(1);
  });

  it('names the tenant resource to detach for a locked tenant setting', async () => {
    TestBed.configureTestingModule({
      imports: [TenantHostComponent],
      providers: [
        {
          provide: ConfigOwnershipService,
          useValue: {
            get: vi.fn(async () => ({ ...fileManaged, kind: 'Tenant', resourceId: 'tenant' })),
          },
        },
      ],
    });
    const fixture = TestBed.createComponent(TenantHostComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(
      (fixture.nativeElement as HTMLElement).querySelector('button')?.getAttribute('title')
    ).toBe(
      'Managed by folder:/config/demo, read-only. To change it, detach Tenant/tenant under Settings > Config Portability'
    );
  });
});
