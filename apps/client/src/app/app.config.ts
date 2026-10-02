import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import {
  type ApplicationConfig,
  importProvidersFrom,
  inject,
  provideAppInitializer,
  provideZoneChangeDetection,
} from '@angular/core';
import { MAT_FORM_FIELD_DEFAULT_OPTIONS } from '@angular/material/form-field';
import { provideRouter } from '@angular/router';
import { FlexLayoutModule } from 'ngx-flexible-layout';
import { routes } from './app.routes';
import { provideFormlyCore } from '@ngx-formly/core';
import { withFormlyMaterial } from '@ngx-formly/material';
import { ObjectTypeComponent } from './types/object.type';
import { ArrayTypeComponent } from './types/array.type';
import { provideMonacoEditor } from 'ngx-monaco-editor-v2';
import schemas from './utils/schemas.json';
import transactionDataSchemaObj from '../../../../schemas/TransactionData.schema.json';
import { ApiService, authInterceptor } from './core';
import { OidcService } from './core/oidc.service';

declare let monaco: any;

const runtimeEnv = globalThis as { env?: { baseHref?: string } };
const baseHref = runtimeEnv.env?.baseHref ?? '/';
const monacoBaseUrl = new URL(
  'assets/monaco/min/vs',
  new URL(baseHref, document.location.origin)
).toString();

function normalizeLocalSchemaUri(uri: string): string {
  return uri.startsWith('./') ? `a://b/${uri.slice(2)}` : uri;
}

const transactionDataArraySchema = {
  uri: 'https://raw.githubusercontent.com/openwallet-foundation/eudiplo/refs/heads/main/schemas/TransactionDataArray.schema.json',
  fileMatch: ['a://b/TransactionDataArray*.schema.json'],
  schema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://raw.githubusercontent.com/openwallet-foundation/eudiplo/refs/heads/main/schemas/TransactionDataArray.schema.json',
    title: 'TransactionDataArray',
    type: 'array',
    items: transactionDataSchemaObj,
  },
};

function toEditorFriendlySchema(node: any): any {
  if (Array.isArray(node)) {
    return node.map((v) => toEditorFriendlySchema(v));
  }

  if (!node || typeof node !== 'object') {
    return node;
  }

  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(node)) {
    if ((key === '$id' || key === '$ref') && typeof value === 'string') {
      out[key] = normalizeLocalSchemaUri(value);
    } else {
      out[key] = toEditorFriendlySchema(value);
    }
  }

  // Monaco JSON suggestions are more stable with anyOf than oneOf for
  // discriminated unions while typing incomplete objects.
  if (Array.isArray(out['oneOf']) && out['discriminator'] && !Array.isArray(out['anyOf'])) {
    out['anyOf'] = out['oneOf'];
    delete out['oneOf'];
  }

  // If a schema already exposes local object properties, flatten trivial allOf
  // wrappers so Monaco can offer property completion inside nested objects.
  if (
    out['type'] === 'object' &&
    out['properties'] &&
    Array.isArray(out['allOf']) &&
    out['allOf'].every((entry: any) => entry && typeof entry === 'object' && '$ref' in entry)
  ) {
    delete out['allOf'];
  }

  return out;
}

function getCredentialFormat(text: string): 'dc+sd-jwt' | 'mso_mdoc' | undefined {
  const match = /"format"\s*:\s*"([^"]+)"/.exec(text);
  const format = match?.[1];
  return format === 'dc+sd-jwt' || format === 'mso_mdoc' ? format : undefined;
}

function isInsideMetaObject(model: any, position: any): boolean {
  const offset = model.getOffsetAt(position);
  const text = model.getValue();
  const metaKeyIndex = text.lastIndexOf('"meta"', offset);
  if (metaKeyIndex === -1) {
    return false;
  }

  const metaOpenIndex = text.indexOf('{', metaKeyIndex);
  if (metaOpenIndex === -1 || offset < metaOpenIndex) {
    return false;
  }

  const metaCloseIndex = text.indexOf('}', metaOpenIndex);
  return metaCloseIndex === -1 || offset <= metaCloseIndex;
}

function registerBrowserJsonCompletions() {
  monaco.languages.registerCompletionItemProvider('json', {
    triggerCharacters: ['"', ':', ',', '{', ' '],
    provideCompletionItems(model: any, position: any) {
      const uriValue = String(model.uri?.toString?.() ?? '');
      const isDcqlSchema = uriValue.includes('DCQL.schema.json');
      const isCredentialQuerySchema =
        uriValue.includes('CredentialQueryDcSdJwt.schema.json') ||
        uriValue.includes('CredentialQueryMsoMdoc.schema.json');

      if (!isDcqlSchema && !isCredentialQuerySchema) {
        return { suggestions: [] };
      }

      const text = model.getValue();
      const format = getCredentialFormat(text);
      const insideMeta = isInsideMetaObject(model, position);

      if (!insideMeta && !isDcqlSchema) {
        return { suggestions: [] };
      }

      const suggestions: any[] = [];
      const addPropertySuggestion = (label: string, insertText: string, detail: string) => {
        suggestions.push({
          label,
          kind: monaco.languages.CompletionItemKind.Property,
          insertText,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          detail,
        });
      };

      if (insideMeta) {
        if (format === 'mso_mdoc') {
          addPropertySuggestion('doctype_value', '"doctype_value": "$1"', 'mso_mdoc meta');
        } else {
          addPropertySuggestion('vct_values', '"vct_values": [$1]', 'dc+sd-jwt meta');
        }
      } else if (isDcqlSchema && format) {
        addPropertySuggestion('meta', '"meta": {$1}', 'credential metadata');
      }

      return { suggestions };
    },
  });
}

function onMonacoLoad() {
  // Expose loaded Monaco instance for components that need URI helpers.
  (globalThis as any).__eudiploMonaco = monaco;

  const editorSchemas = schemas.map((entry) => ({
    ...entry,
    uri: normalizeLocalSchemaUri(entry.uri),
    fileMatch:
      entry.uri === './TransactionData.schema.json'
        ? ['a://b/TransactionData-*.schema.json']
        : entry.uri === './CredentialConfig.schema.json'
          ? ['a://b/CredentialConfig-*.schema.json']
          : entry.fileMatch,
    schema: toEditorFriendlySchema(entry.schema),
  }));

  monaco.languages.json.jsonDefaults.diagnosticsOptions.enableSchemaRequest = true;
  monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
    validate: true,
    schemas: [...editorSchemas, transactionDataArraySchema],
  });

  registerBrowserJsonCompletions();
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideAppInitializer(async () => {
      const oidcService = inject(OidcService);
      const apiService = inject(ApiService);
      await oidcService.initialize();
      // The page reload after the Keycloak redirect resets the API base URL,
      // so re-apply the one the OIDC session was started with.
      apiService.syncWithOidcSession();
    }),
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes),
    importProvidersFrom(FlexLayoutModule),
    provideHttpClient(withInterceptors([authInterceptor]), withFetch()),
    provideMonacoEditor({
      baseUrl: monacoBaseUrl,
      onMonacoLoad,
      //monacoRequire: (window as any).monacoRequire,
      //requireConfig: { preferScriptTags: true }
    }),
    provideFormlyCore([
      ...withFormlyMaterial(),
      {
        types: [
          //{ name: 'null', component: NullTypeComponent, wrappers: ['form-field'] },
          { name: 'array', component: ArrayTypeComponent },
          { name: 'object', component: ObjectTypeComponent },
          //{ name: 'multischema', component: MultiSchemaTypeComponent },
        ],
      },
    ]),
    {
      provide: MAT_FORM_FIELD_DEFAULT_OPTIONS,
      useValue: { appearance: 'outline' },
    },
  ],
};
