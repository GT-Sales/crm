'use client';

import { useEffect, useId, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import {
  emailFillIns,
  fillInsForTemplate,
  updateEmailTemplateRequestSchema,
  type EmailTemplate,
  type PreviewEmailTemplateRequest,
  type PreviewEmailTemplateResponse,
  type UpdateEmailTemplateRequest,
} from '@gt-sales/contracts';
import { Button, FormField, Input, Textarea } from '@gt-sales/ui';

import { BackendError } from '../../lib/api';
import { errorReason } from '../../lib/use-resource';

/** How long the editor waits after the last keystroke before it asks for a preview. */
export const PREVIEW_DELAY_MS = 400;

/** What a 403 from any email call means, as Settings → Email says it. */
export const INTEGRATIONS_PERMISSION_MESSAGE =
  'This needs the Integrations permission (the owner has it).';

const SUBJECT_MAX = 150;
const BODY_MAX = 5000;

const MARKUP_PROBLEMS: Readonly<Record<string, string>> = {
  two_buttons: 'An email can have one button only.',
  button_not_alone: 'Put the button in a paragraph of its own, with a blank line before and after.',
  bad_link: 'A link address must start with http:// or https://, or be {tracking link} on its own.',
};

/**
 * What is wrong with a template's words, from a refused preview or save: the
 * fill-in the email may not use, the markup that cannot be read, or `undefined`
 * when the error is about something else.
 */
export function templateProblem(error: unknown): string | undefined {
  if (!(error instanceof BackendError)) return undefined;
  if (error.status === 403) return INTEGRATIONS_PERMISSION_MESSAGE;
  const details = error.details ?? {};
  if (error.code === 'invalid_fill_in') {
    const fillIn = typeof details['fillIn'] === 'string' ? details['fillIn'] : '';
    const where =
      details['where'] === 'subject'
        ? ' in the subject'
        : details['where'] === 'body'
          ? ' in the body'
          : '';
    return `Unknown fill-in {${fillIn}}${where}. Use one of the fill-ins listed for this email.`;
  }
  if (error.code === 'invalid_email_markup') {
    const reason = typeof details['reason'] === 'string' ? details['reason'] : '';
    return (
      MARKUP_PROBLEMS[reason] ?? 'The formatting could not be read. Check the links and button.'
    );
  }
  return undefined;
}

type PreviewTab = 'email' | 'text';
const PREVIEW_TABS: readonly { key: PreviewTab; label: string }[] = [
  { key: 'email', label: 'Email' },
  { key: 'text', label: 'Text' },
];

/**
 * Edits one customer email's subject and body. A preview of the unsaved words
 * (rendered by the backend with sample values) follows the typing, asked for
 * once the typing has stopped for `PREVIEW_DELAY_MS`; only the newest answer is
 * shown. The rendered HTML is shown in a sandboxed frame, so nothing in it can
 * run. Save sends the version the editor loaded; "Send me a test" mails the
 * saved words to the signed-in staff member. `onSave` and `onSendTest` answer
 * the words to show; `onSave` answers nothing when the save worked.
 */
export function TemplateEditor({
  template,
  preview,
  onSave,
  onSendTest,
  readOnly = false,
}: {
  template: EmailTemplate;
  preview(input: PreviewEmailTemplateRequest): Promise<PreviewEmailTemplateResponse>;
  onSave(input: UpdateEmailTemplateRequest): Promise<string | undefined>;
  onSendTest(): Promise<string | undefined>;
  /** The caller may not change email settings: everything shows, nothing can be changed or sent. */
  readOnly?: boolean;
}): JSX.Element {
  const id = useId();
  const [subject, setSubject] = useState(template.subject);
  const [body, setBody] = useState(template.body);
  const [rendered, setRendered] = useState<PreviewEmailTemplateResponse>();
  const [previewProblem, setPreviewProblem] = useState<string>();
  const [tab, setTab] = useState<PreviewTab>('email');
  const [fieldErrors, setFieldErrors] = useState<{ subject?: string; body?: string }>({});
  const [saveResult, setSaveResult] = useState<{ ok: boolean; text: string }>();
  const [testResult, setTestResult] = useState<string>();
  const [busy, setBusy] = useState(false);

  // The newest preview function and request, so a re-render of the caller never restarts the wait
  // and a slow answer to older words never replaces a newer one.
  const previewRef = useRef(preview);
  const latestPreview = useRef(0);
  useEffect(() => {
    previewRef.current = preview;
  }, [preview]);

  useEffect(() => {
    const timer = setTimeout(() => {
      const request = ++latestPreview.current;
      if (subject.trim() === '' || body.trim() === '') {
        setPreviewProblem('Enter a subject and a body to see the preview.');
        return;
      }
      previewRef.current({ subject, body }).then(
        (answer) => {
          if (request !== latestPreview.current) return;
          setRendered(answer);
          setPreviewProblem(undefined);
        },
        (error: unknown) => {
          if (request !== latestPreview.current) return;
          setPreviewProblem(
            templateProblem(error) ??
              `The preview could not be made. Reason: ${errorReason(error)}.`,
          );
        },
      );
    }, PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [subject, body]);

  // An answer that lands after the editor closed is dropped.
  useEffect(
    () => () => {
      latestPreview.current += 1;
    },
    [],
  );

  async function save() {
    setSaveResult(undefined);
    const errors = {
      ...(subject.trim() === '' ? { subject: 'Enter a subject.' } : {}),
      ...(body.trim() === '' ? { body: 'Enter a body.' } : {}),
    };
    setFieldErrors(errors);
    if (errors.subject || errors.body) return;
    const parsed = updateEmailTemplateRequestSchema.safeParse({
      expectedVersion: template.version,
      subject,
      body,
    });
    if (!parsed.success) {
      setSaveResult({ ok: false, text: 'Check the subject and the body and try again.' });
      return;
    }
    setBusy(true);
    const reason = await onSave(parsed.data);
    setBusy(false);
    setSaveResult(reason ? { ok: false, text: reason } : { ok: true, text: 'Saved.' });
  }

  async function sendTest() {
    setTestResult(undefined);
    setBusy(true);
    const result = await onSendTest();
    setBusy(false);
    setTestResult(result);
  }

  function onTabKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const next: PreviewTab = tab === 'email' ? 'text' : 'email';
    setTab(next);
    document.getElementById(`${id}-tab-${next}`)?.focus();
  }

  const allowed = fillInsForTemplate(template.key);
  const hints = emailFillIns.filter((fillIn) => allowed.includes(fillIn.key));

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="flex flex-col gap-4">
        <fieldset disabled={readOnly || busy} className="flex flex-col gap-4">
          <legend className="sr-only">The words of this email</legend>
          <FormField
            id={`${id}-subject`}
            label="Subject"
            {...(fieldErrors.subject ? { error: fieldErrors.subject } : {})}
          >
            <Input
              value={subject}
              maxLength={SUBJECT_MAX}
              onChange={(event) => setSubject(event.target.value)}
            />
          </FormField>
          <FormField
            id={`${id}-body`}
            label="Body"
            hint="Fill-ins go in braces, such as {first name}."
            {...(fieldErrors.body ? { error: fieldErrors.body } : {})}
          >
            <Textarea
              rows={14}
              value={body}
              maxLength={BODY_MAX}
              className="font-mono text-sm"
              onChange={(event) => setBody(event.target.value)}
            />
          </FormField>
        </fieldset>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" disabled={readOnly || busy} onClick={() => void save()}>
            Save
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={readOnly || busy}
            onClick={() => void sendTest()}
          >
            Send me a test
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          A test mails the saved words to you, with sample values, not unsaved changes.
        </p>
        {saveResult ? (
          saveResult.ok ? (
            <p role="status" className="text-sm text-muted-foreground">
              {saveResult.text}
            </p>
          ) : (
            <p role="alert" className="text-sm text-destructive">
              {saveResult.text}
            </p>
          )
        ) : null}
        {testResult ? (
          <p role="status" aria-live="polite" className="text-sm">
            {testResult}
          </p>
        ) : null}

        <section aria-labelledby={`${id}-fill-ins`} className="flex flex-col gap-2">
          <h3 id={`${id}-fill-ins`} className="text-sm font-semibold">
            Fill-ins
          </h3>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            {hints.map((fillIn) => (
              <div key={fillIn.key} className="contents">
                <dt>
                  <code className="font-mono">{`{${fillIn.key}}`}</code>
                </dt>
                <dd className="text-muted-foreground">{fillIn.hint}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section aria-labelledby={`${id}-formatting`} className="flex flex-col gap-2">
          <h3 id={`${id}-formatting`} className="text-sm font-semibold">
            Formatting
          </h3>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground">
            <li>A blank line starts a new paragraph; a single line break stays a line break.</li>
            <li>
              <code className="font-mono">**bold words**</code> for bold.
            </li>
            <li>
              <code className="font-mono">[label](https://example.com)</code> for a link.
            </li>
            <li>
              <code className="font-mono">[button: Label](https://example.com)</code> for one
              button, alone in its paragraph.
            </li>
            <li>
              A link or button may go to <code className="font-mono">{'{tracking link}'}</code>. The
              subject takes fill-ins only.
            </li>
          </ul>
        </section>
      </div>

      <section aria-labelledby={`${id}-preview`} className="flex min-w-0 flex-col gap-3">
        <h3 id={`${id}-preview`} className="text-sm font-semibold">
          Preview
        </h3>
        <p className="text-xs text-muted-foreground">
          With sample values. It follows your typing, unsaved.
        </p>
        {previewProblem ? (
          <p role="alert" className="text-sm text-destructive">
            {previewProblem}
          </p>
        ) : null}
        <div role="tablist" aria-label="Preview as" className="flex gap-1 border-b">
          {PREVIEW_TABS.map((entry) => (
            <button
              key={entry.key}
              id={`${id}-tab-${entry.key}`}
              type="button"
              role="tab"
              aria-selected={tab === entry.key}
              aria-controls={`${id}-panel`}
              tabIndex={tab === entry.key ? 0 : -1}
              onKeyDown={onTabKey}
              onClick={() => setTab(entry.key)}
              className={`-mb-px border-b-2 px-3 py-1.5 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${
                tab === entry.key
                  ? 'border-primary font-medium'
                  : 'border-transparent text-muted-foreground'
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <div
          id={`${id}-panel`}
          role="tabpanel"
          aria-labelledby={`${id}-tab-${tab}`}
          className="flex flex-col gap-2"
        >
          {rendered ? (
            <>
              <p className="text-sm">
                <span className="text-muted-foreground">Subject: </span>
                <span data-preview-subject="" className="font-medium">
                  {rendered.subject}
                </span>
              </p>
              {tab === 'email' ? (
                <iframe
                  title="Email preview"
                  sandbox=""
                  srcDoc={rendered.html}
                  className="h-[32rem] w-full rounded-md border bg-white"
                />
              ) : (
                <pre className="max-h-[32rem] overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-sm whitespace-pre-wrap">
                  {rendered.text}
                </pre>
              )}
            </>
          ) : (
            <p
              className="text-sm text-muted-foreground"
              aria-busy={previewProblem ? undefined : true}
            >
              {previewProblem ? 'No preview yet.' : 'Making the preview…'}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
