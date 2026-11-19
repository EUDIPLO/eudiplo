/**
 * The items one of whose texts contains the search, ignoring case, sorted by their name as people
 * read it (numbers by value, case ignored). Without a search, all items, sorted.
 */
export function searchAndSort<T>(
  items: readonly T[],
  search: string,
  texts: (item: T) => readonly string[],
  name: (item: T) => string
): T[] {
  const term = search.trim().toLowerCase();
  const matches = term
    ? items.filter((item) => texts(item).some((text) => text.toLowerCase().includes(term)))
    : [...items];
  return matches.sort((a, b) =>
    name(a).localeCompare(name(b), undefined, { numeric: true, sensitivity: 'base' })
  );
}

/**
 * Remembers the last result of `searchAndSort`, so a template getter that reads it on every
 * change detection searches again only when the items or the search changed.
 */
export class SearchCache<T> {
  private last?: { items: readonly T[]; search: string; result: T[] };

  constructor(
    private readonly texts: (item: T) => readonly string[],
    private readonly name: (item: T) => string
  ) {}

  /** The items that match the search, sorted; the same array until the inputs change. */
  result(items: readonly T[], search: string): T[] {
    if (this.last?.items !== items || this.last.search !== search) {
      this.last = { items, search, result: searchAndSort(items, search, this.texts, this.name) };
    }
    return this.last.result;
  }
}
