import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * Diplo, the EUDIPLO logo, drawn inline so it takes the theme's colours:
 * the body uses the primary colour and the credential's folded corner the
 * tertiary container, which gives the brand colours in both light and dark
 * mode. An `<img>` cannot do this, because page styles do not reach an SVG
 * loaded as an image.
 *
 * The logo is decorative and hidden from assistive technology: every place
 * that shows it writes the name next to it.
 *
 * The same path data is in public/logo.svg, apps/docs/static/img/logo.svg,
 * apps/docs/static/img/brand/*.svg, apps/website/logo.svg and the #diplo
 * symbol in apps/website/index.html; change the shape in all of them.
 */
@Component({
  selector: 'app-diplo-logo',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg viewBox="45 285 640 404" focusable="false" aria-hidden="true">
      <path class="body" [attr.d]="body" />
      <path class="fold" [attr.d]="fold" />
    </svg>
  `,
  styleUrl: './diplo-logo.component.scss',
})
export class DiploLogoComponent {
  protected readonly body =
    'M58 638.5C47.3 638.5 46.1 623.8 56.8 621.9C134.6 608.5 214.4 587.1 224.6 538.1V511.1' +
    'C224.6 487.5 242.7 468.8 266 468.8H394.8L453.6 500.7C491.2 485.7 506.9 440.4 531.4 377.3' +
    'C549.7 329.9 565.7 288.8 616.4 288.8H660.1C671.2 288.8 679.7 297.3 679.7 308.6V320.1' +
    'C679.7 332 671.1 341 658.8 342.4L617.5 346.4C597 348.6 588.1 361.8 583.5 379.1' +
    'C573.6 428.7 556.8 526.1 536.2 583.6C525.6 612.2 511.3 629.3 485.8 637.6V672.7' +
    'C485.8 679.8 480.6 685.1 473.3 685.1H432.1C424.7 685.1 419.2 679.8 419.2 672.7V640.7' +
    'Q419.2 638.5 417 638.5H293.8Q291.5 638.5 291.5 640.8V672.7C291.5 679.8 286.2 685.1 278.9 685.1' +
    'H237.8C230.7 685.1 225.1 679.8 225.1 672.7V640.8Q225.1 638.5 222.9 638.5Z';

  protected readonly fold =
    'M391.8 468.6C391.8 463.5 396.4 461 400.6 463.8L514.4 542.1C519.7 545.7 516.9 552.4 511.8 552.4' +
    'H414.8C401.8 552.4 391.8 542.3 391.8 529.5Z';
}
