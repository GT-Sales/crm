import * as React from 'react';

import { Label } from './label';

/**
 * The props `FormField` injects into its single child control. Kept to a
 * narrow, structural subset so any labelled form primitive (`Input`,
 * `Textarea`, `Select`, …) can be passed without an unchecked cast.
 */
export interface FormFieldControlProps {
  id?: string;
  'aria-invalid'?: React.AriaAttributes['aria-invalid'];
  'aria-describedby'?: string;
}

export interface FormFieldProps {
  id: string;
  label: React.ReactNode;
  hint?: React.ReactNode;
  error?: string;
  errorIcon?: React.ReactNode;
  errorBeforeHint?: boolean;
  required?: boolean;
  children: React.ReactElement<FormFieldControlProps>;
}

/**
 * Labelled field wrapper: associates the label, optional hint and optional
 * error with the child control and marks the control invalid only while an
 * error is present.
 */
function FormField({
  id,
  label,
  hint,
  error,
  errorIcon,
  errorBeforeHint = false,
  required = false,
  children,
}: FormFieldProps) {
  const hasError = error !== undefined && error !== '';
  const describedBy = [hint ? `${id}-hint` : undefined, hasError ? `${id}-error` : undefined]
    .filter((value): value is string => value !== undefined)
    .join(' ');

  const control = React.cloneElement(children, {
    id,
    'aria-invalid': hasError,
    'aria-describedby': describedBy === '' ? undefined : describedBy,
  });
  const errorMessage = hasError ? (
    <p
      id={`${id}-error`}
      data-slot="form-field-error"
      role="alert"
      className="text-sm text-destructive"
    >
      {errorIcon}
      {error}
    </p>
  ) : null;

  return (
    <div data-slot="form-field" className="flex flex-col gap-2">
      <Label htmlFor={id}>
        {label}
        {required ? <span className="sr-only"> (required)</span> : null}
      </Label>
      {control}
      {errorBeforeHint ? errorMessage : null}
      {hint ? (
        <p id={`${id}-hint`} data-slot="form-field-hint" className="text-sm text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {errorBeforeHint ? null : errorMessage}
    </div>
  );
}

export { FormField };
