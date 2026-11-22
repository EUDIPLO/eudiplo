import { inject } from '@angular/core';
import type { CanDeactivateFn } from '@angular/router';
import {
  type PageWithUnsavedChanges,
  UnsavedChangesService,
} from '../services/unsaved-changes.service';

/** Asks before a page with unsaved changes is left for another page of the client. */
export const unsavedChangesGuard: CanDeactivateFn<PageWithUnsavedChanges> = (page) =>
  inject(UnsavedChangesService).confirmLeave(page);
