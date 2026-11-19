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
