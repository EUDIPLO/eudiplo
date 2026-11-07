/** The state of an edit screen that decides whether its JSON View can be opened. */
export interface JsonViewState {
  /** While the resource to edit loads. */
  loading: boolean;
  /** Set when the resource to edit could not be loaded; the form stays hidden. */
  loadError: string;
  /** While a save runs; a successful one leaves the screen. */
  saving: boolean;
}

/**
 * Why JSON View of an edit screen cannot be opened right now, or '' when it can. JSON View
 * edits the loaded resource, named by `subject` (for example "the webhook endpoint"), so it
 * waits for the load and, after a failed one, for a retry. It also waits for a running save,
 * since a successful one leaves the screen while the dialog would stay open. The button stays
 * focusable with `disabledInteractive` and shows this as its tooltip; its click handler checks
 * it again, since Material does not block clicks on such a button.
 */
export function jsonViewUnavailableReason(state: JsonViewState, subject: string): string {
  if (state.loading) return `Wait until ${subject} has loaded`;
  if (state.loadError) return `Retry loading ${subject} before opening JSON View`;
  if (state.saving) return `Wait until ${subject} has been saved`;
  return '';
}
