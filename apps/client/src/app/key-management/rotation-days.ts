import { type AbstractControl, type ValidationErrors, Validators } from '@angular/forms';

/** The backend's bounds for `rotationPolicy.intervalDays` and `rotationPolicy.certValidityDays`. */
const MAX_ROTATION_DAYS = 3650;

/** Rejects a value that is not a whole number; an empty value is left to `required`. */
function wholeNumber(control: AbstractControl): ValidationErrors | null {
  const value: unknown = control.value;
  if (value === null || value === undefined || value === '') return null;
  return Number.isInteger(Number(value)) ? null : { wholeNumber: true };
}

/**
 * Validators of the rotation interval and certificate validity fields: a whole number of days
 * from 1 to {@link MAX_ROTATION_DAYS}. The fields' error reads {@link ROTATION_DAYS_ERROR}.
 */
export const rotationDaysValidators = [
  Validators.required,
  Validators.min(1),
  Validators.max(MAX_ROTATION_DAYS),
  wholeNumber,
];

export const ROTATION_DAYS_ERROR = `Enter a whole number of days from 1 to ${MAX_ROTATION_DAYS}`;
