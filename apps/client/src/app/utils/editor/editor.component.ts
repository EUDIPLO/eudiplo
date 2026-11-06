import {
  ControlValueAccessor,
  NG_VALUE_ACCESSOR,
  NG_VALIDATORS,
  Validator,
  ValidationErrors,
  FormsModule,
  ReactiveFormsModule,
} from '@angular/forms';
import { MonacoEditorModule, NgxEditorModel } from 'ngx-monaco-editor-v2';
import Ajv, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import {
  Component,
  forwardRef,
  OnChanges,
  OnDestroy,
  Input,
  SimpleChanges,
  ChangeDetectionStrategy,
  ElementRef,
  inject,
} from '@angular/core';
import { MatInputModule } from '@angular/material/input';
import { SchemaValidation } from '../schemas';
import schemas from '../schemas.json';
import { FlexLayoutModule } from 'ngx-flexible-layout';
import { Subscription } from 'rxjs';
import { ThemeService } from '../../services/theme.service';
import { focusWasLost } from '../../common/focus-if-lost.util';

let editorInstanceCounter = 0;

/**
 * extact the schema that got added by the editor
 */
export function extractSchema(obj: any) {
  if (!obj) return null;
  const element = typeof obj === 'string' ? JSON.parse(obj) : obj;
  delete element.$schema;
  if (Object.keys(element).length === 0) {
    return null;
  }
  return element;
}
@Component({
  selector: 'app-editor',
  standalone: true,
  imports: [FormsModule, ReactiveFormsModule, MonacoEditorModule, MatInputModule, FlexLayoutModule],
  templateUrl: './editor.component.html',
  styleUrls: ['./editor.component.scss'],
  changeDetection: ChangeDetectionStrategy.Eager,
  providers: [
    { provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => EditorComponent), multi: true },
    { provide: NG_VALIDATORS, useExisting: forwardRef(() => EditorComponent), multi: true },
  ],
})
export class EditorComponent implements ControlValueAccessor, Validator, OnChanges, OnDestroy {
  @Input() schema?: SchemaValidation;
  @Input() editorOptions: any = { language: 'json', automaticLayout: true };
  @Input() errors?: ValidationErrors | null = null;

  themedEditorOptions: any;
  model?: NgxEditorModel;

  value = '';
  disabled = false;

  private readonly ajv = new Ajv({ allowUnionTypes: true });
  private validateFn?: ValidateFunction;
  private schemaValidationError?: string;
  private readonly instanceId = ++editorInstanceCounter;
  private modelVersion = 0;
  private editorInitialized = false;
  private themeSubscription: Subscription;
  private markerListener?: { dispose(): void };
  private monacoEditor?: { focus(): void };
  /** Set by `focus()` before Monaco has loaded: the element that had the focus then. */
  private focusRequestedFrom?: Element | null;
  /** The host element, by which a form finds the editor of a field to focus. */
  readonly element: HTMLElement = inject(ElementRef).nativeElement;
  monacoSchemaError?: string;

  constructor(private readonly themeService: ThemeService) {
    this.themedEditorOptions = this.withTheme(this.editorOptions);
    this.themeSubscription = this.themeService.themeChanges.subscribe(() => {
      this.themedEditorOptions = this.withTheme(this.editorOptions);
    });

    addFormats(this.ajv);
    for (const schema of schemas) {
      const key = (schema.schema as any)['$id'].split('/').pop() || '';
      try {
        this.ajv.addSchema(schema.schema, key);
      } catch (error) {
        console.error(`Failed to add schema ${key}:`, error);
      }
    }
  }

  // CVA
  writeValue(obj: any): void {
    this.value = obj == null ? '' : typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);

    if (!this.model) {
      this.rebuildModel();
    } else {
      this.model = { ...this.model, value: this.value };
    }
  }
  registerOnChange = (fn: any) => (this._onChange = fn);
  registerOnTouched = (fn: any) => (this._onTouched = fn);
  setDisabledState(isDisabled: boolean) {
    this.disabled = isDisabled;
  }

  // Validator
  validate(): ValidationErrors | null {
    if (this.editorOptions.language !== 'json') {
      return null;
    }

    const raw = this.value;
    if (!raw) return null;
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { invalidJson: true };
    }

    //if only the schema is included, return null
    if (parsed && Object.keys(parsed).length === 1 && parsed.$schema) {
      return null;
    }

    if (this.validateFn && !this.validateFn(parsed)) {
      const msg = this.formatValidationErrors(this.validateFn.errors);
      return { invalidSchema: msg || 'Schema validation failed' };
    }

    if (this.schema && this.schemaValidationError) {
      return { invalidSchema: this.schemaValidationError };
    }

    return null;
  }
  registerOnValidatorChange?(fn: () => void): void {
    this._validatorChange = fn;
  }

  /**
   * Turn Ajv errors into readable messages, naming the offending property
   * instead of Ajv's generic root "data" placeholder.
   */
  private formatValidationErrors(errors: ValidateFunction['errors']): string {
    if (!errors?.length) {
      return '';
    }

    return errors
      .map((error) => {
        const path = error.instancePath?.replace(/^\//, '').replaceAll('/', '.') || 'root';
        if (error.keyword === 'additionalProperty' || error.keyword === 'additionalProperties') {
          const extra = (error.params as { additionalProperty?: string })?.additionalProperty;
          const suffix = extra ? ` "${extra}"` : '';
          return `${path}: must NOT have additional property${suffix}`;
        }
        return `${path} ${error.message}`;
      })
      .join(' | ');
  }

  // Handlers
  handleChange(newVal: string) {
    this.value = newVal;
    try {
      this._onChange(JSON.parse(newVal));
    } catch {
      this._onChange(newVal);
    }
  }
  onBlur() {
    this._onTouched();
  }

  /**
   * Moves focus into the editor once Monaco has loaded, for example to a field with an error.
   * Monaco's input is a different element in each browser, so only Monaco can focus it.
   */
  focus(): void {
    if (this.monacoEditor) this.monacoEditor.focus();
    // Monaco loads on first use; it takes the focus then, unless the user has moved it meanwhile.
    else this.focusRequestedFrom = document.activeElement;
  }

  onEditorInit(editor: any): void {
    this.monacoEditor = editor;
    if (this.focusRequestedFrom !== undefined) {
      if (focusWasLost(this.focusRequestedFrom)) editor.focus();
      this.focusRequestedFrom = undefined;
    }
    this.editorInitialized = true;
    this.markerListener?.dispose();
    this.markerListener = editor.onDidChangeModelDecorations(() => {
      this.updateMonacoSchemaError(editor);
    });
    this.updateMonacoSchemaError(editor);

    // If URI could not be created before Monaco finished loading,
    // rebuild once so schema fileMatch can attach for autocomplete.
    if (this.schema && !this.model?.uri) {
      this.rebuildModel();
    }
  }

  ngOnChanges(changes: SimpleChanges): void {
    if ('editorOptions' in changes) {
      this.themedEditorOptions = this.withTheme(this.editorOptions);
    }

    if ('editorOptions' in changes || 'schema' in changes) {
      this.rebuildModel();
    }

    if ('schema' in changes) {
      this.schemaValidationError = undefined;
      try {
        const schemaUrl = this.schema?.getSchemaUrl();
        if (this.schema && schemaUrl && !this.ajv.getSchema(schemaUrl)) {
          this.ajv.addSchema(this.schema.getSchema());
        }
        this.validateFn = schemaUrl ? this.ajv.getSchema(schemaUrl) : undefined;
        if (this.schema && !this.validateFn) {
          this.schemaValidationError = `Schema ${schemaUrl || 'unknown'} could not be compiled`;
        }
      } catch (error) {
        this.validateFn = undefined;
        this.schemaValidationError =
          error instanceof Error ? error.message : 'Schema validation setup failed';
      }
      this._validatorChange?.();
    }
  }

  ngOnDestroy(): void {
    this.themeSubscription.unsubscribe();
    this.markerListener?.dispose();
  }

  private _onChange: (v: any) => void = () => {};
  private _onTouched: () => void = () => {};
  private _validatorChange?: () => void;

  private rebuildModel(): void {
    this.modelVersion += 1;
    const uriString = this.schema?.getFileMatchUri(this.instanceId, this.modelVersion);
    const uri = uriString ? this.toMonacoUri(uriString) : undefined;

    this.model = {
      value: this.value,
      language: this.editorOptions?.language ?? 'json',
      // URI-based schema matching is required for Monaco JSON autocomplete.
      uri,
    };
  }

  private withTheme(options: any): any {
    return {
      ...options,
      theme: this.themeService.isDarkMode ? 'vs-dark' : 'vs-light',
    };
  }

  private toMonacoUri(uri: string): any {
    try {
      const monacoGlobal = (globalThis as any).__eudiploMonaco ?? (globalThis as any).monaco;
      if (monacoGlobal?.Uri?.parse) {
        return monacoGlobal.Uri.parse(uri);
      }
    } catch {
      // Fallback for very early lifecycle calls before Monaco global is ready.
    }

    // Before Monaco is initialized, return undefined and let onEditorInit rebuild.
    if (!this.editorInitialized) {
      return undefined;
    }

    return undefined;
  }

  private updateMonacoSchemaError(editor: any): void {
    const monacoGlobal = (globalThis as any).__eudiploMonaco ?? (globalThis as any).monaco;
    const model = editor.getModel?.();
    if (!monacoGlobal?.editor?.getModelMarkers || !model?.uri) {
      return;
    }

    const marker = monacoGlobal.editor
      .getModelMarkers({ resource: model.uri })
      .find((candidate: any) => candidate.severity === monacoGlobal.MarkerSeverity.Error);
    this.monacoSchemaError = marker?.message;
  }
}
