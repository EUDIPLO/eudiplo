import { ValidatorFn } from '@angular/forms';
import Ajv, { ErrorObject } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { SchemaValidation } from './schemas';

/** Validate the form model even when its JSON editor is not mounted. */
export function schemaFormValidator(schema: SchemaValidation): ValidatorFn {
  const ajv = new Ajv({ allowUnionTypes: true });
  addFormats(ajv);
  const validate = ajv.compile(schema.getSchema());
  return (control) => {
    if (control.value == null || control.value === '') return null;
    let value: unknown;
    try {
      value = typeof control.value === 'string' ? JSON.parse(control.value) : control.value;
    } catch {
      return { invalidJson: true };
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const data = { ...(value as Record<string, unknown>) };
      delete data['$schema'];
      value = data;
    }
    return validate(value) ? null : { invalidSchema: describeErrors(validate.errors) };
  };
}

/** Ajv's error text, naming the property that `additionalProperties: false` refused. */
function describeErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map((error) => {
      const text = `data${error.instancePath} ${error.message}`;
      const extra = (error.params as { additionalProperty?: string }).additionalProperty;
      return error.keyword === 'additionalProperties' && extra ? `${text} "${extra}"` : text;
    })
    .join('; ');
}
