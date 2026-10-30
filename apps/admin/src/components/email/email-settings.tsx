'use client';

import { useId, useState, type JSX } from 'react';
import {
  CUSTOMER_EMAIL_TEMPLATE_LABELS,
  DEFAULT_EMAIL_BRAND_COLOR,
  updateEmailSettingsRequestSchema,
  type CustomerEmailTemplate,
  type EmailSettingsResponse,
  type PreviewEmailTemplateRequest,
  type UpdateEmailSettingsRequest,
  type UpdateEmailTemplateRequest,
} from '@gt-sales/contracts';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  FormField,
  Input,
  Textarea,
} from '@gt-sales/ui';

import {
  BackendError,
  previewEmailTemplate,
  sendTestEmail,
  updateEmailSettings,
  updateEmailTemplate,
} from '../../lib/api';
import { errorReason } from '../../lib/use-resource';
import { useStaffSession } from '../staff-session-provider';
import { OWNER_ONLY_MESSAGE, TemplateEditor, templateProblem } from './template-editor';
import { TemplateList } from './template-list';
import { isForbidden, useEmailSettings } from './use-email-settings';

const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

type FieldKey =
  'fromName' | 'fromAddress' | 'replyTo' | 'logoUrl' | 'brandColor' | 'footerText' | 'siteUrl';

/** What each field needs, said when the value given is not it. */
const FIELD_HELP: Readonly<Record<FieldKey, string>> = {
  fromName: 'Enter a sender name of 80 characters or fewer.',
  fromAddress: 'Enter an email address, such as orders@example.com.',
  replyTo: 'Enter an email address, or leave it empty.',
  logoUrl: 'Enter a link that starts with https://, or leave it empty.',
  brandColor: 'Enter a colour as #rrggbb, such as #d72638.',
  footerText: 'Keep the footer to 500 characters or fewer.',
  siteUrl: 'Enter a link that starts with https://, or leave it empty.',
};

function fieldKeyOf(value: PropertyKey | undefined): FieldKey | undefined {
  const keys: readonly FieldKey[] = [
    'fromName',
    'fromAddress',
    'replyTo',
    'logoUrl',
    'brandColor',
    'footerText',
    'siteUrl',
  ];
  return keys.find((key) => key === value);
}

type Values = Record<FieldKey, string>;

function initialValues({ settings, fallback }: EmailSettingsResponse): Values {
  if (settings) {
    return {
      fromName: settings.fromName,
      fromAddress: settings.fromAddress,
      replyTo: settings.replyTo ?? '',
      logoUrl: settings.logoUrl ?? '',
      brandColor: settings.brandColor,
      footerText: settings.footerText,
      siteUrl: settings.siteUrl ?? '',
    };
  }
  return {
    fromName: fallback?.fromName ?? '',
    fromAddress: fallback?.fromAddress ?? '',
    replyTo: '',
    logoUrl: '',
    brandColor: DEFAULT_EMAIL_BRAND_COLOR,
    footerText: '',
    siteUrl: fallback?.siteUrl ?? '',
  };
}

const orNull = (value: string) => (value.trim() === '' ? null : value.trim());

/**
 * The site's sender and the look of its mails: sender name and address,
 * reply-to, logo, brand colour, footer and site address. Until the owner saves
 * them the form starts from the sender the server is configured with, and says
 * so. The whole form is sent on save, empty optional fields as null and the
 * colour in lower case. `onSave` answers why a save was refused, or nothing.
 */
export function EmailSettings({
  initial,
  onSave,
  readOnly = false,
}: {
  initial: EmailSettingsResponse;
  onSave(input: UpdateEmailSettingsRequest): Promise<string | undefined>;
  /** The caller may not change email settings: the form shows, disabled. */
  readOnly?: boolean;
}): JSX.Element {
  const id = useId();
  const [values, setValues] = useState<Values>(() => initialValues(initial));
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [result, setResult] = useState<{ ok: boolean; text: string }>();
  const [busy, setBusy] = useState(false);

  const set = (key: FieldKey, value: string) =>
    setValues((current) => ({ ...current, [key]: value }));
  const errorProp = (key: FieldKey) => (errors[key] ? { error: errors[key] } : {});

  async function save() {
    setResult(undefined);
    const parsed = updateEmailSettingsRequestSchema.safeParse({
      fromName: values.fromName,
      fromAddress: values.fromAddress.trim(),
      replyTo: orNull(values.replyTo),
      logoUrl: orNull(values.logoUrl),
      brandColor: values.brandColor.trim(),
      footerText: values.footerText,
      siteUrl: orNull(values.siteUrl),
    });
    if (!parsed.success) {
      const next: Partial<Record<FieldKey, string>> = {};
      for (const issue of parsed.error.issues) {
        const key = fieldKeyOf(issue.path[0]);
        if (key) next[key] = FIELD_HELP[key];
      }
      setErrors(next);
      return;
    }
    setErrors({});
    setBusy(true);
    const reason = await onSave(parsed.data);
    setBusy(false);
    setResult(reason ? { ok: false, text: reason } : { ok: true, text: 'Saved.' });
  }

  const pickerValue = COLOR_PATTERN.test(values.brandColor)
    ? values.brandColor.toLowerCase()
    : DEFAULT_EMAIL_BRAND_COLOR;

  return (
    <form
      noValidate
      aria-labelledby={`${id}-heading`}
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <h2 id={`${id}-heading`} className="text-base font-semibold">
        Sender
      </h2>
      {initial.settings === null ? (
        <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          {initial.fallback
            ? `Not saved yet: mail goes out as ${initial.fallback.fromName} <${initial.fallback.fromAddress}> from the server's configuration.`
            : 'Not saved yet: there is no sender, so no email goes out until these are saved.'}
        </p>
      ) : null}
      <fieldset disabled={readOnly || busy} className="grid gap-4 md:grid-cols-2">
        <legend className="sr-only">Sender settings</legend>
        <FormField id={`${id}-from-name`} label="Sender name" {...errorProp('fromName')}>
          <Input
            value={values.fromName}
            maxLength={80}
            autoComplete="organization"
            onChange={(event) => set('fromName', event.target.value)}
          />
        </FormField>
        <FormField
          id={`${id}-from-address`}
          label="Sender address"
          hint="Must be on a domain verified in Resend; send yourself a test to check."
          {...errorProp('fromAddress')}
        >
          <Input
            type="email"
            value={values.fromAddress}
            onChange={(event) => set('fromAddress', event.target.value)}
          />
        </FormField>
        <FormField
          id={`${id}-reply-to`}
          label="Reply-to address"
          hint="Where customers’ replies go. Leave it empty to use the sender address."
          {...errorProp('replyTo')}
        >
          <Input
            type="email"
            value={values.replyTo}
            onChange={(event) => set('replyTo', event.target.value)}
          />
        </FormField>
        <FormField
          id={`${id}-logo`}
          label="Logo URL"
          hint="An https:// link to the image shown at the top of each email."
          {...errorProp('logoUrl')}
        >
          <Input
            type="url"
            value={values.logoUrl}
            onChange={(event) => set('logoUrl', event.target.value)}
          />
        </FormField>
        <div className="flex flex-col gap-2">
          <FormField
            id={`${id}-brand-color`}
            label="Brand colour"
            hint="The colour of the button and the top bar, as #rrggbb."
            {...errorProp('brandColor')}
          >
            <Input
              value={values.brandColor}
              maxLength={7}
              spellCheck={false}
              onChange={(event) => set('brandColor', event.target.value)}
            />
          </FormField>
          <input
            type="color"
            aria-label="Brand colour picker"
            value={pickerValue}
            className="h-9 w-16 cursor-pointer rounded-md border bg-transparent p-1 disabled:cursor-not-allowed disabled:opacity-50"
            onChange={(event) => set('brandColor', event.target.value.toLowerCase())}
          />
        </div>
        <FormField
          id={`${id}-site-url`}
          label="Site address"
          hint="The website’s https:// address, linked from each email."
          {...errorProp('siteUrl')}
        >
          <Input
            type="url"
            value={values.siteUrl}
            onChange={(event) => set('siteUrl', event.target.value)}
          />
        </FormField>
        <div className="md:col-span-2">
          <FormField
            id={`${id}-footer`}
            label="Footer"
            hint="Shown at the bottom of each email, such as the business name and address."
            {...errorProp('footerText')}
          >
            <Textarea
              rows={3}
              value={values.footerText}
              maxLength={500}
              onChange={(event) => set('footerText', event.target.value)}
            />
          </FormField>
        </div>
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={readOnly || busy}>
          Save settings
        </Button>
        {result ? (
          result.ok ? (
            <p role="status" className="text-sm text-muted-foreground">
              {result.text}
            </p>
          ) : (
            <p role="alert" className="text-sm text-destructive">
              {result.text}
            </p>
          )
        ) : null}
      </div>
    </form>
  );
}

const CONFLICT_MESSAGE = 'This email changed elsewhere. Reload and try again.';

/**
 * Settings → Email: the sender form, the seven emails and the editor of one
 * of them, opened from its Edit button or from `initialTemplate` (the
 * `?template=` the Automations page links with). Every call needs the owner's
 * `integration.manage`; a refusal anywhere says so and turns the page
 * read-only.
 */
export function EmailSettingsScreen({
  workspaceSlug,
  initialTemplate,
}: {
  workspaceSlug: string;
  initialTemplate?: CustomerEmailTemplate;
}): JSX.Element {
  const staff = useStaffSession();
  const workspaceId = staff.workspaces.find((item) => item.slug === workspaceSlug)?.id;
  const accessToken = staff.accessToken;
  const { settings, templates, forbidden, reload, error } = useEmailSettings(workspaceId);
  const [editing, setEditing] = useState<CustomerEmailTemplate | undefined>(initialTemplate);
  const [refused, setRefused] = useState(false);
  const readOnly = forbidden || refused;

  /** One call; a 403 turns the page read-only. Answers the result, or the error it threw. */
  async function call<T>(
    action: (token: string, id: string) => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
    if (!accessToken || !workspaceId) {
      return { ok: false, error: new Error('signed_out') };
    }
    try {
      return { ok: true, value: await action(accessToken, workspaceId) };
    } catch (caught) {
      if (isForbidden(caught)) setRefused(true);
      return { ok: false, error: caught };
    }
  }

  async function saveSettings(input: UpdateEmailSettingsRequest): Promise<string | undefined> {
    const outcome = await call((token, id) => updateEmailSettings(token, id, input));
    if (!outcome.ok) {
      if (isForbidden(outcome.error)) return OWNER_ONLY_MESSAGE;
      return `The settings were not saved. Reason: ${errorReason(outcome.error)}.`;
    }
    await reload();
    return undefined;
  }

  async function saveTemplate(
    key: CustomerEmailTemplate,
    input: UpdateEmailTemplateRequest,
  ): Promise<string | undefined> {
    const outcome = await call((token, id) => updateEmailTemplate(token, id, key, input));
    if (!outcome.ok) {
      if (outcome.error instanceof BackendError && outcome.error.code === 'version_conflict') {
        return CONFLICT_MESSAGE;
      }
      return (
        templateProblem(outcome.error) ??
        `The email was not saved. Reason: ${errorReason(outcome.error)}.`
      );
    }
    await reload();
    return undefined;
  }

  async function preview(key: CustomerEmailTemplate, input: PreviewEmailTemplateRequest) {
    const outcome = await call((token, id) => previewEmailTemplate(token, id, key, input));
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  async function sendTest(key: CustomerEmailTemplate): Promise<string> {
    const outcome = await call((token, id) => sendTestEmail(token, id, key));
    if (outcome.ok) {
      return outcome.value.queued
        ? 'Sent to your address: check your inbox.'
        : 'A test was already sent this minute.';
    }
    if (isForbidden(outcome.error)) return OWNER_ONLY_MESSAGE;
    if (outcome.error instanceof BackendError && outcome.error.code === 'feature_not_ready') {
      return 'There is no sender to mail from yet. Save the sender settings first.';
    }
    return `The test was not sent. Reason: ${errorReason(outcome.error)}.`;
  }

  if (forbidden) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {OWNER_ONLY_MESSAGE}
      </p>
    );
  }
  if (!settings) {
    return error ? (
      <p role="alert" className="text-sm text-destructive">
        The email settings could not be loaded. Reason: {error}.
      </p>
    ) : (
      <p className="text-sm text-muted-foreground" aria-busy="true">
        Loading the email settings…
      </p>
    );
  }

  const template = templates.find((entry) => entry.key === editing);

  return (
    <div className="flex flex-col gap-10">
      {refused ? (
        <p role="alert" className="text-sm text-destructive">
          {OWNER_ONLY_MESSAGE}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          The email settings could not be refreshed. Reason: {error}.
        </p>
      ) : null}
      <EmailSettings initial={settings} onSave={saveSettings} readOnly={readOnly} />
      <section aria-labelledby="email-templates-heading" className="flex flex-col gap-3">
        <h2 id="email-templates-heading" className="text-base font-semibold">
          Emails
        </h2>
        <p className="text-sm text-muted-foreground">
          The words of each email the site sends its customers. Whether an email is sent is set on
          the Automations page.
        </p>
        <TemplateList
          workspaceSlug={workspaceSlug}
          templates={templates}
          onEdit={setEditing}
          readOnly={readOnly}
        />
      </section>

      <Dialog open={template !== undefined} onOpenChange={(open) => !open && setEditing(undefined)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-6xl">
          <DialogHeader>
            <DialogTitle>
              {template ? CUSTOMER_EMAIL_TEMPLATE_LABELS[template.key] : 'Email'}
            </DialogTitle>
            <DialogDescription>
              Change the subject and the words of this email. The preview uses sample values.
            </DialogDescription>
          </DialogHeader>
          {template ? (
            <TemplateEditor
              key={template.key}
              template={template}
              preview={(input) => preview(template.key, input)}
              onSave={(input) => saveTemplate(template.key, input)}
              onSendTest={() => sendTest(template.key)}
              readOnly={readOnly}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
