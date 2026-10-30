import { afterEach, describe, expect, it, vi } from 'vitest';

import { JsonViewDialogComponent } from './json-view-dialog.component';

describe('JsonViewDialogComponent copy', () => {
  afterEach(() => {
    delete (navigator as { clipboard?: Clipboard }).clipboard;
  });

  const create = (open = vi.fn()) =>
    new JsonViewDialogComponent(
      {} as never,
      { title: 'Config', jsonData: { id: 'pid' }, readonly: false } as never,
      { open } as never
    );

  it('copies what the editor shows, including edits', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const component = create();
    component.jsonControl.setValue('{ "id": "edited" }');

    await component.copyJson();

    expect(writeText).toHaveBeenCalledWith('{ "id": "edited" }');
  });

  it('says to copy the JSON from the editor by hand when nothing was copied', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    const open = vi.fn();

    await create(open).copyJson();

    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith(
      'Could not copy the JSON. Select it in the editor and copy it by hand.',
      'Close',
      expect.objectContaining({ duration: expect.any(Number) })
    );
  });
});
