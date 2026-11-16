import { ChangeDetectionStrategy, Component, input } from '@angular/core';

let nextId = 0;

/**
 * Diplo, the EUDIPLO logo: the dinosaur head on a navy badge with a yellow
 * sun. The badge keeps its own colours in light and dark mode.
 *
 * The logo is decorative and hidden from assistive technology: every place
 * that shows it writes the name next to it.
 *
 * With `eyesClosed`, Diplo turns its head away and shuts its eye, for example
 * while someone types a secret.
 *
 * The same drawing is in public/logo.svg, apps/docs/static/img/logo.svg and
 * apps/docs/static/img/brand/diplo.svg; change the shape in all of them.
 */
@Component({
  selector: 'app-diplo-logo',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class.eyes-closed]': 'eyesClosed()' },
  template: `
    <svg viewBox="0 0 176 176" focusable="false" aria-hidden="true">
      <defs>
        <clipPath [attr.id]="clipId">
          <circle cx="88.3" cy="87.8" r="87.7" />
        </clipPath>
      </defs>
      <g [attr.clip-path]="'url(#' + clipId + ')'">
        <path fill="#1e1c4b" d="M0 0h176v176H0z" />
        <g class="head">
          <path
            fill="#a0a2f7"
            d="m64 41.7-10.3 3.6L58.2 56Zm-7.5 14.1-9 5.3 5.1 8.5Zm-4.4 16.8-8.4 5 6.1 7.5Z"
          />
          <path
            fill="#6266f0"
            d="M65 39C53 54 47.5 80 47.2 109.2c-.3 23.8 7.6 46.5 18.5 67.8H72L69 100 81 69Z"
          />
          <path fill="#fff" d="M77 76h9.5c-5.9 33.2-.1 74.6 38.5 94.2l-12 7.8H79Z" />
          <path
            fill="#a0a2f7"
            d="M86.3 26.3c14.1-1.6 23 3.8 29.4 15.9 2.8 5.4 5.1 8.4 8.6 13.2 2.2 2.8 3.5 5.4 3.2 9.3-.2 3.4-1.9 5.9-4.9 7.8-.1 5.1-3.4 8.2-10.2 8.4l-30.9.5c-5.3 32.7-4.8 67.9 32.5 90.8l-11 8H69.9c-8.5-18.9-17.7-40.7-17.7-56.4 0-16.1 9.6-33 18.9-47.2-8.1-5.1-11.5-13.1-11.5-21.6 0-17.6 9-26.7 26.7-28.7Z"
          />
          <path fill="#fff" d="m98.3 72 24.3.2-.5 2.8Z" />
          <g class="eye">
            <circle cx="82.2" cy="43.4" r="5.65" fill="#fff" />
            <circle cx="85.45" cy="44.45" r="2.25" fill="#1e1c4b" />
          </g>
          <path
            class="lid"
            d="M77 42.8Q81.8 48.8 87.5 42.6"
            fill="none"
            stroke="#1e1c4b"
            stroke-width="2.4"
            stroke-linecap="round"
          />
        </g>
      </g>
      <circle cx="26.9" cy="26.15" r="12.85" fill="#ffc53b" />
    </svg>
  `,
  styleUrl: './diplo-logo.component.scss',
})
export class DiploLogoComponent {
  /** Turns the head away and closes the eye. */
  readonly eyesClosed = input(false);

  /** Unique per instance, so two logos on one page never share a clip path. */
  protected readonly clipId = `diplo-badge-${nextId++}`;
}
