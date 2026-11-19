import { describe, expect, it } from 'vitest';

import { searchAndSort } from './search-list';

describe('searchAndSort', () => {
  const items = [
    { name: 'item10', roles: ['audit:read'] },
    { name: 'Item2', roles: ['issuance:offer'] },
    { name: 'other', roles: ['AUDIT:read'] },
  ];
  const texts = (item: (typeof items)[number]) => [item.name, ...item.roles];
  const name = (item: (typeof items)[number]) => item.name;

  it('sorts by name with numbers by value and case ignored', () => {
    expect(searchAndSort(items, '  ', texts, name).map(name)).toEqual(['Item2', 'item10', 'other']);
  });

  it('keeps the items one of whose texts contains the search, ignoring case', () => {
    expect(searchAndSort(items, ' Audit ', texts, name).map(name)).toEqual(['item10', 'other']);
  });

  it('leaves the given list as it is', () => {
    searchAndSort(items, '', texts, name);

    expect(items.map(name)).toEqual(['item10', 'Item2', 'other']);
  });
});
