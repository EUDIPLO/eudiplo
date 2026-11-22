import { TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { describe, expect, it, vi } from 'vitest';

import {
  CancelSessionDialogComponent,
  type CancelSessionDialogData,
} from './cancel-session-dialog.component';

describe('CancelSessionDialogComponent', () => {
  function render(data: CancelSessionDialogData) {
    TestBed.configureTestingModule({
      imports: [CancelSessionDialogComponent],
      providers: [
        { provide: MAT_DIALOG_DATA, useValue: data },
        { provide: MatDialogRef, useValue: { close: vi.fn() } },
      ],
    });
    const fixture = TestBed.createComponent(CancelSessionDialogComponent);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    const text = (selector: string) =>
      element.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim();
    const buttons = [...element.querySelectorAll('mat-dialog-actions button')].map((button) =>
      button.textContent?.trim()
    );
    return { title: text('h2'), body: text('mat-dialog-content p'), confirm: buttons.at(-1) };
  }

  it('names one issuance offer and what stays valid', () => {
    expect(render({ offers: 1, requests: 0 })).toEqual({
      title: 'Cancel offer?',
      body: 'A wallet can no longer use this offer to start a flow. Offers a wallet already redeemed can no longer be cancelled, and credentials that were already issued stay valid.',
      confirm: 'Cancel offer',
    });
  });

  it('names one verification request, without the issued credentials', () => {
    expect(render({ offers: 0, requests: 1 })).toEqual({
      title: 'Cancel request?',
      body: 'A wallet can no longer use this request to start a flow. Requests a wallet already answered can no longer be cancelled.',
      confirm: 'Cancel request',
    });
  });

  it('counts several requests', () => {
    expect(render({ offers: 0, requests: 3 })).toMatchObject({
      title: 'Cancel 3 requests?',
      confirm: 'Cancel requests',
    });
  });

  it('names offers and requests selected together', () => {
    const { title, body, confirm } = render({ offers: 2, requests: 1 });

    expect(title).toBe('Cancel 2 offers and 1 request?');
    expect(body).toContain('these offers and requests');
    expect(body).toContain('credentials that were already issued stay valid');
    expect(body).toContain('Requests a wallet already answered');
    expect(confirm).toBe('Cancel offers and requests');
  });
});
