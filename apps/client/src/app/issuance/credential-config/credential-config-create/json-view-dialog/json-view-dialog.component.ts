import { ChangeDetectionStrategy, Component, ElementRef, Inject, ViewChild } from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTabsModule } from '@angular/material/tabs';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MonacoEditorModule } from 'ngx-monaco-editor-v2';
import { EditorComponent } from '../../../../utils/editor/editor.component';
import { SchemaValidation } from '../../../../utils/schemas';
import { copyToClipboard } from '../../../../utils/copy-to-clipboard';
import { openErrorSnackBar } from '../../../../utils/error-snackbar';
import { focusField } from '../../../../common/field-to-fix.util';

export interface JsonViewDialogData {
  title: string;
  jsonData: any;
  readonly?: boolean;
  schema: SchemaValidation;
  /**
   * Saves the applied JSON before the dialog closes, and resolves to whether it was saved. When
   * it was not, the dialog stays open with the edited JSON; the caller says why. Without it,
   * Apply Changes closes the dialog with the JSON and the caller saves it.
   */
  save?: (json: unknown) => Promise<boolean>;
}

@Component({
  selector: 'app-json-view-dialog',
  standalone: true,
  imports: [
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    MatTabsModule,
    MatTooltipModule,
    MatSnackBarModule,
    ReactiveFormsModule,
    MonacoEditorModule,
    EditorComponent,
  ],
  templateUrl: './json-view-dialog.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './json-view-dialog.component.scss',
})
export class JsonViewDialogComponent {
  jsonControl = new FormControl('');
  formattedJson: string;
  /** True while `data.save` runs; the dialog cannot be closed or applied again meanwhile. */
  saving = false;

  editorOptions = {
    language: 'json',
  };

  /** Apply Changes moves focus here when the JSON cannot be applied. */
  @ViewChild('jsonEditor', { read: ElementRef })
  private readonly jsonEditor?: ElementRef<HTMLElement>;

  constructor(
    public dialogRef: MatDialogRef<JsonViewDialogComponent>,
    @Inject(MAT_DIALOG_DATA) public data: JsonViewDialogData,
    private snackBar: MatSnackBar
  ) {
    this.formattedJson = JSON.stringify(data.jsonData, null, 2);
    this.jsonControl.setValue(this.formattedJson);
    if (data.readonly) {
      this.jsonControl.disable();
    }
  }

  /** Copies what the editor shows, including the user's edits. */
  async copyJson(): Promise<void> {
    const value: unknown = this.jsonControl.value;
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? {}, null, 2);
    await copyToClipboard(
      this.snackBar,
      text,
      'JSON copied to clipboard',
      'Could not copy the JSON. Select it in the editor and copy it by hand.'
    );
  }

  cancel(): void {
    this.dialogRef.close();
  }

  async save(): Promise<void> {
    if (this.saving) return;
    const problem = this.jsonProblem();
    if (problem) {
      this.jsonControl.markAsTouched();
      openErrorSnackBar(this.snackBar, problem);
      if (this.jsonEditor) focusField(this.jsonEditor.nativeElement);
      return;
    }
    if (!this.jsonControl.valid || !this.jsonControl.value) return;
    let json: unknown;
    try {
      const value: unknown = this.jsonControl.value;
      json = typeof value === 'string' ? JSON.parse(value) : value;
    } catch {
      this.snackBar.open('Invalid JSON format', 'OK', { duration: 3000 });
      return;
    }
    if (this.data.save) {
      this.saving = true;
      try {
        if (!(await this.data.save(json))) return;
      } finally {
        this.saving = false;
      }
    }
    this.dialogRef.close(json);
  }

  /** Why the JSON in the editor cannot be applied, as the editor says under it; '' when it can. */
  private jsonProblem(): string {
    const errors = this.jsonControl.errors;
    if (errors?.['invalidJson']) return 'Fix the JSON first: it is not valid JSON.';
    if (errors?.['invalidSchema']) return `Fix the JSON first: ${errors['invalidSchema']}`;
    if (!this.jsonControl.value) return 'Enter the JSON to apply.';
    return '';
  }
}
