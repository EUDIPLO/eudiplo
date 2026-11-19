import { Component, Inject, OnInit, ChangeDetectionStrategy } from '@angular/core';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatDividerModule } from '@angular/material/divider';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { JsonPipe } from '@angular/common';
import { getApiErrorMessage } from '../../../utils/error-message';
import { ResolvedSchema, SchemaImportResult, SchemaBrowserService } from './schema-browser.service';

export interface SchemaBrowserDialogData {
  initialUrl?: string;
}

@Component({
  selector: 'app-schema-browser',
  standalone: true,
  imports: [
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    MatCheckboxModule,
    MatCardModule,
    MatDividerModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
    ReactiveFormsModule,
    JsonPipe,
  ],
  providers: [SchemaBrowserService],
  templateUrl: './schema-browser.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './schema-browser.component.scss',
})
export class SchemaBrowserComponent implements OnInit {
  urlControl = new FormControl('', [Validators.required, Validators.pattern(/^https?:\/\/.+/)]);

  loading = false;
  error: string | null = null;
  resolved: ResolvedSchema | null = null;

  selectedFormats = new Map<string, boolean>();

  constructor(
    public dialogRef: MatDialogRef<SchemaBrowserComponent>,
    @Inject(MAT_DIALOG_DATA) public data: SchemaBrowserDialogData | null,
    private readonly schemaBrowserService: SchemaBrowserService
  ) {}

  ngOnInit(): void {
    if (this.data?.initialUrl) {
      this.urlControl.setValue(this.data.initialUrl);
      this.fetchSchemaMetadata();
    }
  }

  async fetchSchemaMetadata(): Promise<void> {
    if (this.urlControl.invalid) return;

    this.loading = true;
    this.error = null;
    this.resolved = null;
    this.selectedFormats.clear();

    try {
      this.resolved = await this.schemaBrowserService.fetchSchema(this.urlControl.value!);
      for (const format of this.resolved.schema.supportedFormats) {
        this.selectedFormats.set(format, true);
      }
    } catch (err: unknown) {
      console.error('Failed to fetch schema metadata:', err);
      this.error = getApiErrorMessage(err, 'Failed to fetch schema');
    } finally {
      this.loading = false;
    }
  }

  toggleFormat(format: string, selected: boolean): void {
    this.selectedFormats.set(format, selected);
  }

  hasSelections(): boolean {
    return Array.from(this.selectedFormats.values()).some(Boolean);
  }

  getSelectedFormats(): string[] {
    return Array.from(this.selectedFormats.entries())
      .filter(([, selected]) => selected)
      .map(([format]) => format);
  }

  getResolvedReferences(): {
    format: string;
    uri: string;
    integrity?: string;
    meta?: Record<string, unknown>;
    parsedSchema?: Record<string, unknown>;
  }[] {
    return this.resolved?.schema.resolvedReferences ?? [];
  }

  hasResolvedReferences(): boolean {
    return this.getResolvedReferences().length > 0;
  }

  getGeneratedDcql(): object {
    if (!this.resolved?.schema.dcqlQuery) {
      return { credentials: [] };
    }

    const selected = new Set(this.getSelectedFormats());
    const allCredentials =
      (this.resolved.schema.dcqlQuery as { credentials?: Record<string, unknown>[] }).credentials ??
      [];

    return {
      credentials: allCredentials.filter((credential) => {
        const format = credential['format'];
        return typeof format === 'string' && selected.has(format);
      }),
    };
  }

  close(): void {
    this.dialogRef.close();
  }

  insert(): void {
    if (!this.resolved || !this.hasSelections()) return;
    const importResult: SchemaImportResult = this.schemaBrowserService.generateImportResult(
      this.resolved,
      this.getSelectedFormats()
    );
    this.dialogRef.close(importResult);
  }
}
