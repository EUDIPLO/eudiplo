import { Injectable } from '@angular/core';

export type NavSection =
  | 'settings'
  | 'administration'
  | 'crypto'
  | 'integrations'
  | 'issuance'
  | 'registrar'
  | 'verification'
  | 'sessions';

/** Route prefixes of the pages each navigation section links to. */
export const NAV_SECTION_ROUTES: Record<NavSection, string[]> = {
  settings: ['/settings'],
  administration: ['/tenants', '/clients', '/users', '/admin'],
  crypto: ['/keys', '/trust-list', '/federation-trust-anchor', '/kms'],
  integrations: ['/webhook-endpoints'],
  issuance: [
    '/offer/issuance',
    '/credential-config',
    '/issuance-config',
    '/status-lists',
    '/status-list-config',
    '/attribute-providers',
  ],
  registrar: ['/registrar', '/schema'],
  verification: ['/offer/presentation', '/presentation-config', '/oidc-clients'],
  sessions: ['/session-management'],
};

const storageKey = 'eudiplo.nav.collapsed.v1';

/**
 * Remembers which navigation sections the user collapsed. Like the theme, this is a layout
 * choice of the browser, not of the signed-in client.
 */
@Injectable({ providedIn: 'root' })
export class NavSectionsService {
  /** The user's choice, saved in this browser. */
  private readonly collapsed = new Set<NavSection>(this.load());
  /** Section of the current page. */
  private current?: NavSection;
  /** Sections shown because the user navigated into them, until a reload; never saved. */
  private readonly revealed = new Set<NavSection>();

  isCollapsed(section: NavSection): boolean {
    return this.collapsed.has(section) && !this.revealed.has(section);
  }

  toggle(section: NavSection): void {
    if (this.isCollapsed(section)) {
      this.collapsed.delete(section);
    } else {
      this.collapsed.add(section);
      this.revealed.delete(section);
    }
    this.save();
  }

  /**
   * Shows the section of a page the user enters from elsewhere, so the active entry is visible.
   * It stays open when the user moves on, so the entries below never move under the pointer.
   * Moving within a section, for example filtering a list, keeps a collapse the user just made.
   */
  navigatedTo(url: string): void {
    const section = this.sectionOf(url);
    if (section === this.current) return;
    this.current = section;
    if (section) this.revealed.add(section);
  }

  /** The section whose pages include this URL, if any. */
  sectionOf(url: string): NavSection | undefined {
    const path = url.split(/[?#]/)[0];
    return (Object.keys(NAV_SECTION_ROUTES) as NavSection[]).find((section) =>
      NAV_SECTION_ROUTES[section].some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
    );
  }

  private save(): void {
    try {
      localStorage.setItem(storageKey, JSON.stringify([...this.collapsed]));
    } catch {
      // Collapsing still works for this visit when storage is blocked.
    }
  }

  private load(): NavSection[] {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
      return Array.isArray(saved)
        ? saved.filter(
            (section): section is NavSection =>
              typeof section === 'string' && Object.hasOwn(NAV_SECTION_ROUTES, section)
          )
        : [];
    } catch {
      return [];
    }
  }
}
