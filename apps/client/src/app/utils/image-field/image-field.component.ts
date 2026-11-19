import { MatTooltipModule } from '@angular/material/tooltip';
import {
  Component,
  Input,
  ElementRef,
  ViewChild,
  ChangeDetectionStrategy,
  OnInit,
} from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { storageControllerUpload } from '@eudiplo/sdk-core';
import { MatButtonModule } from '@angular/material/button';
import { getApiErrorMessage } from '../error-message';
import { openErrorSnackBar } from '../error-snackbar';

@Component({
  selector: 'app-image-field',
  imports: [
    ReactiveFormsModule,
    MatInputModule,
    MatIconModule,
    MatSnackBarModule,
    MatButtonModule,
    MatTooltipModule,
  ],
  templateUrl: './image-field.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: ['./image-field.component.scss'],
})
export class ImageFieldComponent implements OnInit {
  @Input() field!: FormControl<string>;
  @Input() label!: string;
  @Input() required = false;
  @ViewChild('logoFileInput') logoFileInput!: ElementRef<HTMLInputElement>;
  previewReady = false;

  get shouldRenderPreview(): boolean {
    return this.previewReady && !!this.field?.value;
  }

  constructor(private snackBar: MatSnackBar) {}

  ngOnInit(): void {
    // Defer preview rendering to keep the initial form interactive.
    const enablePreview = () => {
      this.previewReady = true;
    };

    const env = globalThis as {
      requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
    };

    if (typeof env.requestIdleCallback === 'function') {
      env.requestIdleCallback(enablePreview, { timeout: 1200 });
      return;
    }

    setTimeout(enablePreview, 250);
  }

  triggerLogoFileInput() {
    this.logoFileInput.nativeElement.click();
  }

  uploadLogoFile(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    const file = input.files[0];

    storageControllerUpload({ body: { file } })
      .then((response: any) => {
        const url = response.url || response.data?.url;
        this.field.setValue(url);
        this.field.markAsDirty();
        this.snackBar.open('Logo uploaded!', 'Close', { duration: 2000 });
      })
      .catch((error: unknown) => {
        openErrorSnackBar(this.snackBar, getApiErrorMessage(error, 'Upload failed'));
      });
  }
}
