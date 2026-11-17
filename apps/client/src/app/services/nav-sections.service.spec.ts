import { NavSectionsService } from './nav-sections.service';

describe('NavSectionsService', () => {
  const key = 'eudiplo.nav.collapsed.v1';

  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('starts with every section expanded', () => {
    const sections = new NavSectionsService();

    expect(sections.isCollapsed('issuance')).toBe(false);
  });

  it('remembers collapsed sections in this browser', () => {
    new NavSectionsService().toggle('issuance');

    const reloaded = new NavSectionsService();
    expect(reloaded.isCollapsed('issuance')).toBe(true);
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual(['issuance']);

    reloaded.toggle('issuance');
    expect(new NavSectionsService().isCollapsed('issuance')).toBe(false);
  });

  it('ignores unknown or malformed saved sections', () => {
    localStorage.setItem(key, JSON.stringify(['issuance', 'unknown', 'constructor', 3]));
    const sections = new NavSectionsService();
    expect(sections.isCollapsed('issuance')).toBe(true);
    sections.toggle('crypto');
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual(['issuance', 'crypto']);

    localStorage.setItem(key, '{broken');
    expect(new NavSectionsService().isCollapsed('issuance')).toBe(false);
  });

  it.each([
    ['/credential-config/pid', 'issuance'],
    ['/offer/presentation?requestId=pid', 'verification'],
    ['/oidc-clients/c7d1/edit', 'verification'],
    ['/session-management/config', 'sessions'],
    ['/settings/connection', 'settings'],
    ['/keys', 'crypto'],
    ['/trust-list/membership-issuers/edit', 'crypto'],
    ['/federation-trust-anchor/create', 'crypto'],
    ['/status-list-config', 'issuance'],
  ] as const)('finds the section of %s', (url, section) => {
    expect(new NavSectionsService().sectionOf(url)).toBe(section);
  });

  it('does not match a route that only starts with the same letters', () => {
    expect(new NavSectionsService().sectionOf('/keysmith')).toBeUndefined();
    expect(new NavSectionsService().sectionOf('/dashboard')).toBeUndefined();
  });

  it('ignores saved values that are not a list', () => {
    localStorage.setItem(key, '{"issuance":true}');

    expect(new NavSectionsService().isCollapsed('issuance')).toBe(false);
  });

  it('collapses for this visit when storage is blocked', () => {
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    const sections = new NavSectionsService();

    expect(() => sections.toggle('issuance')).not.toThrow();
    expect(sections.isCollapsed('issuance')).toBe(true);
  });

  it('shows the section of a page the user enters without changing the saved choice', () => {
    const sections = new NavSectionsService();
    sections.toggle('crypto');
    sections.toggle('issuance');

    sections.navigatedTo('/keys/create');

    expect(sections.isCollapsed('crypto')).toBe(false);
    expect(sections.isCollapsed('issuance')).toBe(true);
    expect(new NavSectionsService().isCollapsed('crypto')).toBe(true);
  });

  it('keeps a section it opened when the user moves on, until a reload', () => {
    const sections = new NavSectionsService();
    sections.toggle('crypto');
    sections.navigatedTo('/keys');

    sections.navigatedTo('/dashboard');

    expect(sections.isCollapsed('crypto')).toBe(false);
    expect(new NavSectionsService().isCollapsed('crypto')).toBe(true);
  });

  it('keeps a collapse while the user moves within the section', () => {
    const sections = new NavSectionsService();
    sections.navigatedTo('/session-management');
    sections.toggle('sessions');

    sections.navigatedTo('/session-management?status=failed');
    sections.navigatedTo('/session-management/session-1');

    expect(sections.isCollapsed('sessions')).toBe(true);
  });

  it('collapses a section it opened when the user asks, and opens it again on request', () => {
    const sections = new NavSectionsService();
    sections.toggle('crypto');
    sections.navigatedTo('/keys');

    sections.toggle('crypto');
    expect(sections.isCollapsed('crypto')).toBe(true);

    sections.toggle('crypto');
    expect(sections.isCollapsed('crypto')).toBe(false);
    expect(new NavSectionsService().isCollapsed('crypto')).toBe(false);
  });
});
