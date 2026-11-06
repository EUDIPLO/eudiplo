import type { ParamMap, Params } from '@angular/router';

/**
 * A form that misses an item, such as a key chain or a trust anchor, links to
 * the page that creates it in a new tab, so what was entered stays. Such a link
 * adds these query parameters to its own. The create page then tells the user
 * to return to the form's tab instead of taking this tab elsewhere.
 */
export function fromFormQueryParams(params: Params): Params {
  return { ...params, from: 'form' };
}

/** An item created for a form in another tab, shown with `<app-return-to-form>`. */
export interface CreatedForForm {
  id: string;
  /** What was created, for example `Key chain "Tokens" created`. */
  heading: string;
}

/** True when the page was opened by a link with {@link fromFormQueryParams}. */
export function openedFromForm(params: ParamMap): boolean {
  return params.get('from') === 'form';
}
