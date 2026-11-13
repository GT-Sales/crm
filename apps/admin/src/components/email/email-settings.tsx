'use client';

import { useId, useState, type JSX } from 'react';
import {
  DEFAULT_EMAIL_BRAND_COLOR,
  DEFAULT_EMAIL_STYLE,
  EMAIL_STYLES,
  EMAIL_TEMPLATE_MAX_SITE_MADE,
  createEmailTemplateRequestSchema,
  emailFillIns,
  emailTemplateLabel,
  fillInsForTemplate,
  isSiteTemplateKey,
  updateEmailSettingsRequestSchema,
  type EmailSettingsResponse,
  type EmailStyle,
  type EmailTemplateKey,
  type PreviewEmailTemplateRequest,
  type SiteEmailTemplate,
  type SiteTemplateKey,
  type UpdateEmailSettingsRequest,
  type UpdateEmailTemplateRequest,
} from '@gt-sales/contracts';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  FormField,
  Input,
  NativeSelect,
  Textarea,
} from '@gt-sales/ui';

import {
  BackendError,
  archiveEmailTemplate,
  createEmailTemplate,
  listEmailTemplates,
  previewEmailTemplate,
  restoreEmailTemplate,
  sendTestEmail,
  updateEmailSettings,
  updateEmailTemplate,
} from '../../lib/api';
import { describeError, describeInvalid } from '../../lib/error-text';
import { useStaffSession } from '../staff-session-provider';
import {
  BODY_MAX,
  INTEGRATIONS_PERMISSION_MESSAGE,
  SUBJECT_MAX,
  TemplateEditor,
  templateProblem,
} from './template-editor';
import { TemplateList } from './template-list';
import { isForbidden, useEmailSettings } from './use-email-settings';
import { LoadingSkeleton } from '../crm/loading-skeleton';

const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

type FieldKey =
  | 'fromName'
  | 'fromAddress'
  | 'replyTo'
  | 'logoUrl'
  | 'brandColor'
  | 'footerText'
  | 'siteUrl'
  | 'style'
  | 'accentColor';

/** The Style choices as the form names them. */
const STYLE_LABELS: Readonly<Record<EmailStyle, string>> = {
  classic: 'Classic',
  hero: 'Website hero',
};

const STYLE_HINTS: Readonly<Record<EmailStyle, string>> = {
  classic: 'Logo centred over a brand-colour rule, with a footer band.',
  hero: 'A brand-colour header with the site name, the status pill and the opening heading. The logo is not shown.',
};

const isEmailStyle = (value: string): value is EmailStyle =>
  EMAIL_STYLES.some((entry) => entry === value);

/** What each field needs, said when the value given is not it. */
const FIELD_HELP: Readonly<Record<FieldKey, string>> = {
  fromName: 'Enter a sender name of 80 characters or fewer.',
  fromAddress: 'Enter an email address, such as orders@example.com.',
  replyTo: 'Enter an email address, or leave it empty.',
  logoUrl: 'Enter a link that starts with https://, or leave it empty.',
  brandColor: 'Enter a colour as #rrggbb, such as #d72638.',
  footerText: 'Keep the footer to 500 characters or fewer.',
  siteUrl: 'Enter a link that starts with https://, or leave it empty.',
  style: 'Choose Classic or Website hero.',
  accentColor: 'Enter a colour as #rrggbb, such as #c0ff72, or leave it empty.',
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
    'style',
    'accentColor',
  ];
  return keys.find((key) => key === value);
}

type Values = Record<FieldKey, string>;

function initialValues({ settings }: EmailSettingsResponse): Values {
  if (settings) {
    return {
      fromName: settings.fromName,
      fromAddress: settings.fromAddress,
      replyTo: settings.replyTo ?? '',
      logoUrl: settings.logoUrl ?? '',
      brandColor: settings.brandColor,
      footerText: settings.footerText,
      siteUrl: settings.siteUrl ?? '',
      style: settings.style,
      accentColor: settings.accentColor ?? '',
    };
  }
  return {
    fromName: '',
    fromAddress: '',
    replyTo: '',
    logoUrl: '',
    brandColor: DEFAULT_EMAIL_BRAND_COLOR,
    footerText: '',
    siteUrl: '',
    style: DEFAULT_EMAIL_STYLE,
    accentColor: '',
  };
}

const orNull = (value: string) => (value.trim() === '' ? null : value.trim());

/** `color` moved toward white by `amount` (0–1), as the mail layout tints the brand. */
function tint(color: string, amount: number): string {
  const channel = (index: number) => {
    const value = Number.parseInt(color.slice(index, index + 2), 16);
    return Math.round(value + (255 - value) * amount)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${channel(1)}${channel(3)}${channel(5)}`;
}

/** `color` moved toward black by `amount` (0–1). */
function shade(color: string, amount: number): string {
  const channel = (index: number) =>
    Math.round(Number.parseInt(color.slice(index, index + 2), 16) * (1 - amount))
      .toString(16)
      .padStart(2, '0');
  return `#${channel(1)}${channel(3)}${channel(5)}`;
}

/**
 * A small sketch of how the chosen style frames a mail, in the colours typed
 * so far. It follows the form as it changes; the template editor's preview
 * draws a real mail once the settings are saved.
 */
function StyleSketch({
  style,
  brandColor,
  accentColor,
  siteName,
}: {
  style: EmailStyle;
  brandColor: string;
  accentColor: string | null;
  siteName: string;
}): JSX.Element {
  const name = siteName.trim() === '' ? 'Your site' : siteName.trim();
  const lines = (
    <div aria-hidden="true" className="flex flex-col gap-1.5">
      <div className="h-1.5 w-11/12 rounded-full bg-slate-200" />
      <div className="h-1.5 w-3/4 rounded-full bg-slate-200" />
    </div>
  );
  const button = (
    <div
      className="mx-auto mt-3 h-4 w-24 rounded-full"
      style={{ background: brandColor }}
      aria-hidden="true"
    />
  );
  if (style === 'hero') {
    const accent = accentColor ?? tint(brandColor, 0.82);
    return (
      <div className="rounded-lg p-3" style={{ background: '#eef2f7' }}>
        <div className="overflow-hidden rounded-lg bg-white">
          <div
            className="px-3 pb-3 pt-2.5"
            style={{
              background: `linear-gradient(135deg, ${brandColor}, ${shade(brandColor, 0.18)})`,
            }}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-[9px] font-bold uppercase tracking-wide text-white/80">
                {name}
              </span>
              <span
                className="rounded-full px-1.5 py-0.5 text-[8px] font-bold uppercase text-slate-900"
                style={{ background: accent }}
              >
                Order received
              </span>
            </div>
            <div className="mt-2 text-xs font-extrabold text-white">Thanks, Nadia</div>
          </div>
          <div className="px-3 py-3">
            {lines}
            {button}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="rounded-lg p-3" style={{ background: '#f4ece1' }}>
      <div className="overflow-hidden rounded-lg bg-white">
        <div className="truncate px-3 py-2 text-center text-xs font-extrabold text-slate-900">
          {name}
        </div>
        <div className="h-1" style={{ background: brandColor }} aria-hidden="true" />
        <div className="flex flex-col items-center px-3 py-3">
          <span
            className="mb-1.5 rounded-full px-1.5 py-0.5 text-[8px] font-bold"
            style={{ background: tint(brandColor, 0.9), color: shade(brandColor, 0.15) }}
          >
            Order received
          </span>
          <div className="mb-2 text-xs font-extrabold text-slate-900">Thanks, Nadia</div>
          <div className="w-full">{lines}</div>
          {button}
        </div>
      </div>
    </div>
  );
}

/**
 * The site's sender and the look of its mails: sender name and address,
 * reply-to, logo, brand colour, site address, style (with a sketch that
 * follows the form), accent colour and footer. Until they are saved
 * the form starts empty and says the site sends no email until then. The
 * whole form is sent on save, empty optional fields as null and the colour in
 * lower case. `onSave` answers why a save was refused, or nothing.
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
      style: values.style,
      accentColor: orNull(values.accentColor),
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
  const accentValue = COLOR_PATTERN.test(values.accentColor.trim())
    ? values.accentColor.trim().toLowerCase()
    : null;
  const style: EmailStyle = isEmailStyle(values.style) ? values.style : DEFAULT_EMAIL_STYLE;

  return (
    <form
      noValidate
      aria-labelledby={`${id}-heading`}
      className="overflow-hidden rounded-xl border border-border/80 bg-card/30"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-5 py-3.5">
        <div>
          <div className="flex items-center gap-2">
            <h2 id={`${id}-heading`} className="text-sm font-medium text-foreground">
              Sender
            </h2>
            <Badge
              variant={initial.settings === null ? 'secondary' : 'outline'}
              className="text-[11px] font-normal"
            >
              {initial.settings === null ? 'Not configured' : 'Configured'}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            From name, verified address, reply-to, and brand styling for outgoing customer emails.
          </p>
        </div>
        <Button type="submit" size="sm" disabled={readOnly || busy}>
          Save settings
        </Button>
      </div>

      <div className="flex flex-col gap-4 p-5">
        {initial.settings === null ? (
          <p className="rounded-lg border border-dashed border-border/80 bg-muted/20 p-3 text-xs text-muted-foreground">
            Not saved yet: this site sends no email until you save these settings.
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
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
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
            </div>
            <input
              type="color"
              aria-label="Brand colour picker"
              value={pickerValue}
              className="mt-6 h-9 w-12 shrink-0 cursor-pointer rounded-md border bg-transparent p-1 disabled:cursor-not-allowed disabled:opacity-50"
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
          <FormField
            id={`${id}-style`}
            label="Style"
            hint={STYLE_HINTS[style]}
            {...errorProp('style')}
          >
            <NativeSelect
              value={style}
              onChange={(event) => {
                if (isEmailStyle(event.target.value)) set('style', event.target.value);
              }}
            >
              {EMAIL_STYLES.map((entry) => (
                <option key={entry} value={entry}>
                  {STYLE_LABELS[entry]}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <FormField
                id={`${id}-accent-color`}
                label="Accent colour"
                hint="The status pill in the Website hero style, as #rrggbb. Leave it empty for a light tint of the brand colour."
                {...errorProp('accentColor')}
              >
                <Input
                  value={values.accentColor}
                  maxLength={7}
                  spellCheck={false}
                  placeholder="#c0ff72"
                  onChange={(event) => set('accentColor', event.target.value)}
                />
              </FormField>
            </div>
            <input
              type="color"
              aria-label="Accent colour picker"
              value={accentValue ?? tint(pickerValue, 0.82)}
              className="mt-6 h-9 w-12 shrink-0 cursor-pointer rounded-md border bg-transparent p-1 disabled:cursor-not-allowed disabled:opacity-50"
              onChange={(event) => set('accentColor', event.target.value.toLowerCase())}
            />
          </div>
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
        <figure className="flex flex-col gap-2 md:max-w-sm" aria-label="Style preview">
          <StyleSketch
            style={style}
            brandColor={pickerValue}
            accentColor={accentValue}
            siteName={values.fromName}
          />
          <figcaption className="text-xs text-muted-foreground">
            {STYLE_LABELS[style]} style, in your colours. Open an email below to preview it in full
            once saved.
          </figcaption>
        </figure>
        {result ? (
          result.ok ? (
            <p role="status" className="text-xs text-muted-foreground">
              {result.text}
            </p>
          ) : (
            <p role="alert" className="text-xs text-destructive">
              {result.text}
            </p>
          )
        ) : null}
      </div>
    </form>
  );
}

const CONFLICT_MESSAGE =
  'Someone else saved this template. The latest version is loaded and your draft is kept. Check it, then save again.';

const TEMPLATE_LIMIT_MESSAGE = `This site already has ${EMAIL_TEMPLATE_MAX_SITE_MADE} custom email templates. Archive one before adding another.`;

function NewTemplateForm({
  onCreate,
  onCancel,
}: {
  onCreate(input: { name: string; subject: string; body: string }): Promise<string | undefined>;
  onCancel(): void;
}): JSX.Element {
  const id = useId();
  const [name, setName] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [fieldErrors, setFieldErrors] = useState<{
    name?: string;
    subject?: string;
    body?: string;
  }>({});
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);

  const allowed = fillInsForTemplate('tpl_aaaaaaaaaaaaaaaa');
  const hints = emailFillIns.filter((fillIn) => allowed.includes(fillIn.key));

  async function submit() {
    setProblem(undefined);
    const errors = {
      ...(name.trim() === '' ? { name: 'Enter a name.' } : {}),
      ...(subject.trim() === '' ? { subject: 'Enter a subject.' } : {}),
      ...(body.trim() === '' ? { body: 'Enter a body.' } : {}),
    };
    setFieldErrors(errors);
    if (errors.name || errors.subject || errors.body) return;
    const parsed = createEmailTemplateRequestSchema.safeParse({ name, subject, body });
    if (!parsed.success) {
      setProblem(
        describeInvalid(parsed.error, {
          name: 'The name',
          subject: 'The subject',
          body: 'The body',
        }),
      );
      return;
    }
    setBusy(true);
    const reason = await onCreate(parsed.data);
    setBusy(false);
    if (reason) setProblem(reason);
  }

  return (
    <div className="flex flex-col gap-4">
      <fieldset disabled={busy} className="flex flex-col gap-4">
        <legend className="sr-only">New email template</legend>
        <FormField
          id={`${id}-name`}
          label="Name"
          hint="How staff pick this email in an automation flow."
          {...(fieldErrors.name ? { error: fieldErrors.name } : {})}
        >
          <Input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
        </FormField>
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
          hint="Fill-ins go in braces, such as {first name} or {prop:custom_size}."
          {...(fieldErrors.body ? { error: fieldErrors.body } : {})}
        >
          <Textarea
            rows={10}
            value={body}
            maxLength={BODY_MAX}
            className="font-mono text-sm"
            onChange={(event) => setBody(event.target.value)}
          />
        </FormField>
      </fieldset>
      {problem ? (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" disabled={busy} onClick={() => void submit()}>
          Create template
        </Button>
        <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
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
          <div className="contents">
            <dt>
              <code className="font-mono">{'{prop:<key>}'}</code>
            </dt>
            <dd className="text-muted-foreground">
              A non-sensitive lead property, such as {'{prop:custom_size}'}
            </dd>
          </div>
        </dl>
      </section>
    </div>
  );
}

/**
 * Settings → Email: the sender form, the nine built-in emails plus the site's
 * own templates (`tpl_…`), and the editor of one of them, opened from its Edit
 * button or from `initialTemplate` (the `?template=` the Automations page
 * links with). Every call needs `integration.manage` (the Integrations
 * permission, which the owner has); a refusal anywhere says so and turns the
 * page read-only.
 */
export function EmailSettingsScreen({
  workspaceSlug,
  initialTemplate,
}: {
  workspaceSlug: string;
  initialTemplate?: EmailTemplateKey;
}): JSX.Element {
  const staff = useStaffSession();
  const workspaceId = staff.workspaces.find((item) => item.slug === workspaceSlug)?.id;
  const accessToken = staff.accessToken;
  const { settings, templates, forbidden, reload, error, failure } = useEmailSettings(workspaceId);
  const [editing, setEditing] = useState<EmailTemplateKey | undefined>(initialTemplate);
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [archivedTemplates, setArchivedTemplates] = useState<SiteEmailTemplate[]>([]);
  const [archivedNextBefore, setArchivedNextBefore] = useState<string | null>(null);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const [actionError, setActionError] = useState<string>();
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

  async function loadArchived(before?: string): Promise<void> {
    setArchivedLoading(true);
    const outcome = await call((token, id) =>
      listEmailTemplates(token, id, { archived: '1', ...(before ? { before } : {}) }),
    );
    setArchivedLoading(false);
    if (!outcome.ok) {
      if (!isForbidden(outcome.error)) {
        setActionError(describeError(outcome.error, 'load the archived templates'));
      }
      return;
    }
    setArchivedTemplates((current) =>
      before ? [...current, ...outcome.value.templates] : outcome.value.templates,
    );
    setArchivedNextBefore(outcome.value.nextBefore);
  }

  async function toggleArchived(): Promise<void> {
    if (showArchived) {
      setShowArchived(false);
      return;
    }
    setShowArchived(true);
    await loadArchived();
  }

  async function saveSettings(input: UpdateEmailSettingsRequest): Promise<string | undefined> {
    const outcome = await call((token, id) => updateEmailSettings(token, id, input));
    if (!outcome.ok) {
      if (isForbidden(outcome.error)) return INTEGRATIONS_PERMISSION_MESSAGE;
      return describeError(outcome.error, 'save the settings');
    }
    await reload();
    return undefined;
  }

  async function createNewTemplate(input: {
    name: string;
    subject: string;
    body: string;
  }): Promise<string | undefined> {
    const outcome = await call((token, id) => createEmailTemplate(token, id, input));
    if (!outcome.ok) {
      if (
        outcome.error instanceof BackendError &&
        outcome.error.code === 'email_template_limit_reached'
      ) {
        return TEMPLATE_LIMIT_MESSAGE;
      }
      return templateProblem(outcome.error) ?? describeError(outcome.error, 'create the template');
    }
    setCreating(false);
    await reload();
    return undefined;
  }

  async function saveTemplate(
    key: EmailTemplateKey,
    input: UpdateEmailTemplateRequest,
  ): Promise<string | undefined> {
    const outcome = await call((token, id) => updateEmailTemplate(token, id, key, input));
    if (!outcome.ok) {
      if (outcome.error instanceof BackendError && outcome.error.code === 'version_conflict') {
        // The newest version, so the next Save can go over it; the editor keeps
        // the draft (it stays mounted under the same key).
        void reload();
        return CONFLICT_MESSAGE;
      }
      return templateProblem(outcome.error) ?? describeError(outcome.error, 'save the email');
    }
    await reload();
    return undefined;
  }

  async function archive(key: SiteTemplateKey): Promise<void> {
    setActionError(undefined);
    const outcome = await call((token, id) => archiveEmailTemplate(token, id, key));
    if (!outcome.ok) {
      if (!isForbidden(outcome.error)) {
        setActionError(describeError(outcome.error, 'archive the template'));
      }
      return;
    }
    await reload();
    if (showArchived) await loadArchived();
  }

  async function restore(key: SiteTemplateKey): Promise<void> {
    setActionError(undefined);
    const outcome = await call((token, id) => restoreEmailTemplate(token, id, key));
    if (!outcome.ok) {
      if (
        outcome.error instanceof BackendError &&
        outcome.error.code === 'email_template_limit_reached'
      ) {
        setActionError(TEMPLATE_LIMIT_MESSAGE);
        return;
      }
      if (!isForbidden(outcome.error)) {
        setActionError(describeError(outcome.error, 'restore the template'));
      }
      return;
    }
    await reload();
    if (showArchived) await loadArchived();
  }

  async function preview(key: EmailTemplateKey, input: PreviewEmailTemplateRequest) {
    const outcome = await call((token, id) => previewEmailTemplate(token, id, key, input));
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  async function sendTest(key: EmailTemplateKey): Promise<string> {
    const outcome = await call((token, id) => sendTestEmail(token, id, key));
    if (outcome.ok) {
      return outcome.value.queued
        ? 'Sent to your address: check your inbox.'
        : 'A test was already sent this minute.';
    }
    if (isForbidden(outcome.error)) return INTEGRATIONS_PERMISSION_MESSAGE;
    if (outcome.error instanceof BackendError && outcome.error.code === 'feature_not_ready') {
      return 'There is no sender to mail from yet. Save the sender settings first.';
    }
    return describeError(outcome.error, 'send the test email');
  }

  if (forbidden) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {INTEGRATIONS_PERMISSION_MESSAGE}
      </p>
    );
  }
  if (!settings) {
    return error ? (
      <p role="alert" className="text-sm text-destructive">
        {describeError(failure ?? error, 'load the email settings')}
      </p>
    ) : (
      <LoadingSkeleton label="Loading the email settings…" variant="form" />
    );
  }

  const found = templates.find((entry) => entry.key === editing);
  const template = found && editing ? { ...found, key: editing } : undefined;

  return (
    <div className="flex flex-col gap-10">
      {refused ? (
        <p role="alert" className="text-sm text-destructive">
          {INTEGRATIONS_PERMISSION_MESSAGE}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {describeError(failure ?? error, 'refresh the email settings')}
        </p>
      ) : null}
      {actionError ? (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      ) : null}
      <EmailSettings initial={settings} onSave={saveSettings} readOnly={readOnly} />
      <section
        aria-labelledby="email-templates-heading"
        className="overflow-hidden rounded-xl border border-border/80 bg-card/30"
      >
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-5 py-3.5">
          <div>
            <div className="flex items-center gap-2">
              <h2 id="email-templates-heading" className="text-sm font-medium text-foreground">
                Emails
              </h2>
              <Badge variant="secondary" className="text-xs font-normal">
                {templates.length}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              The words of each email the site sends its customers. Whether an email is sent is set
              on the Automations page.
            </p>
          </div>
          {readOnly ? null : (
            <Button type="button" size="sm" onClick={() => setCreating(true)}>
              New template
            </Button>
          )}
        </div>
        <TemplateList
          workspaceSlug={workspaceSlug}
          templates={templates}
          onEdit={setEditing}
          onArchive={(key) => void archive(key)}
          readOnly={readOnly}
        />
        <div className="flex flex-col gap-2 border-t border-border/70 bg-muted/10 px-5 py-3">
          <div>
            <Button type="button" size="sm" variant="ghost" onClick={() => void toggleArchived()}>
              {showArchived ? 'Hide archived templates' : 'Archived templates'}
            </Button>
          </div>
          {showArchived ? (
            archivedLoading && archivedTemplates.length === 0 ? (
              <LoadingSkeleton label="Loading archived templates…" variant="list" />
            ) : archivedTemplates.length === 0 ? (
              <p className="text-xs text-muted-foreground">No archived templates.</p>
            ) : (
              <div className="flex flex-col gap-2">
                <ul
                  aria-label="Archived emails"
                  className="divide-y divide-border/70 rounded-lg border border-border/70 bg-background/50"
                >
                  {archivedTemplates.map((entry) => {
                    const siteKey = isSiteTemplateKey(entry.key) ? entry.key : undefined;
                    return (
                      <li
                        key={entry.key}
                        className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5"
                      >
                        <div className="mr-auto flex min-w-0 flex-col gap-0.5">
                          <h3 className="text-sm font-medium">{entry.name}</h3>
                          <p className="text-xs text-muted-foreground">Version {entry.version}</p>
                        </div>
                        {!readOnly && siteKey ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            aria-label={`Restore ${entry.name}`}
                            onClick={() => void restore(siteKey)}
                          >
                            Restore
                          </Button>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
                {archivedNextBefore ? (
                  <div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={archivedLoading}
                      onClick={() => void loadArchived(archivedNextBefore)}
                    >
                      Load more
                    </Button>
                  </div>
                ) : null}
              </div>
            )
          ) : null}
        </div>
      </section>

      <Dialog open={creating} onOpenChange={(open) => !open && setCreating(false)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>New template</DialogTitle>
            <DialogDescription>
              Create a customer email template that automation flows on this site can send.
            </DialogDescription>
          </DialogHeader>
          <NewTemplateForm onCreate={createNewTemplate} onCancel={() => setCreating(false)} />
        </DialogContent>
      </Dialog>

      <Dialog open={template !== undefined} onOpenChange={(open) => !open && setEditing(undefined)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-6xl">
          <DialogHeader>
            <DialogTitle>
              {template ? emailTemplateLabel(template.key, template.name) : 'Email'}
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
