'use client';

import { useId, useMemo, useState } from 'react';
import type {
  AiCatalogueModel,
  AiModelSettingsResponse,
  AiSavedModelSettings,
} from '@gt-sales/contracts';
import { BotIcon, InfoIcon, SearchIcon } from 'lucide-react';
import { Badge, Button, Card, CardContent, Checkbox, Input, cn } from '@gt-sales/ui';

import { BackendError, getAiModelSettings, updateAiModelSettings } from '../../lib/api';
import { dateTimeLabel } from '../../lib/dates';
import { describeError, errorKind } from '../../lib/error-text';
import { useResource } from '../../lib/use-resource';
import { LoadingSkeleton } from '../crm/loading-skeleton';
import { useStaffSession } from '../staff-session-provider';

/**
 * Settings → AI models, the owner's choice of Ask AI's models: which Gateway
 * models members may pick in the composer and which one answers when nobody
 * picks. Top to bottom: what is in use now, what the owner should know
 * (tool calls, hosts), and Edit models, a searchable list of the Gateway's
 * language models with their vendor and price, up to 8 ticked and one marked
 * as the default. The backend answers the owner alone; an older backend reads
 * as "not available yet", a database without migration 0040 as "not switched
 * on yet", and a catalogue that cannot be read leaves what is saved in place.
 * Model names, ids and descriptions come from the Gateway and go in as text.
 */
export function AiModelsScreen({ workspaceSlug }: { workspaceSlug: string }) {
  const { accessToken, workspaces } = useStaffSession();
  const workspaceId = workspaces.find((entry) => entry.slug === workspaceSlug)?.id;
  const load = useMemo(
    () =>
      accessToken && workspaceId ? () => getAiModelSettings(accessToken, workspaceId) : undefined,
    [accessToken, workspaceId],
  );
  const settings = useResource(load);
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<string>();

  if (settings.error) {
    return <LoadFailed failure={settings.failure} onRetry={() => void settings.reload()} />;
  }
  if (!settings.data) return <LoadingSkeleton label="Loading AI models…" variant="report" />;
  const data = settings.data;
  const canEdit = data.storage && data.catalogue.available;

  return (
    <div aria-busy={settings.loading} className="flex flex-col gap-6">
      <States data={data} onRetry={() => void settings.reload()} />
      {editing && accessToken && workspaceId ? (
        <ModelEditor
          data={data}
          onCancel={() => setEditing(false)}
          onSave={async (body) => {
            const saved = await updateAiModelSettings(accessToken, workspaceId, body);
            settings.mutate((current) => ({ ...current, saved: saved.saved }));
            setEditing(false);
            setNotice('Saved. Members see the new models the next time they open Ask AI.');
          }}
        />
      ) : (
        <>
          <InUse data={data} />
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              disabled={!canEdit}
              onClick={() => {
                setNotice(undefined);
                setEditing(true);
              }}
            >
              Edit models
            </Button>
            {notice ? (
              <p role="status" className="text-sm text-muted-foreground">
                {notice}
              </p>
            ) : null}
          </div>
        </>
      )}
      <Notes data={data} />
    </div>
  );
}

/** True for a refusal that means this route is not there (an older backend). */
function isNotAvailable(failure: unknown): boolean {
  return failure instanceof BackendError && (failure.status === 404 || failure.status === 503);
}

function LoadFailed({ failure, onRetry }: { failure: unknown; onRetry: () => void }) {
  if (
    errorKind(failure) === 'permission' ||
    (failure instanceof BackendError && failure.status === 403)
  ) {
    return (
      <p role="alert" className="text-sm text-muted-foreground">
        {describeError(failure, 'view Ask AI’s models')}
      </p>
    );
  }
  const unavailable = isNotAvailable(failure);
  return (
    <div
      role={unavailable ? 'status' : 'alert'}
      className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground"
    >
      <p>
        {unavailable
          ? 'Choosing Ask AI’s models is not available yet. It will appear here once the CRM is updated.'
          : describeError(failure, 'load Ask AI’s models')}
      </p>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

/** One plain notice per state that stops or limits a change, most blocking first. */
function States({ data, onRetry }: { data: AiModelSettingsResponse; onRetry: () => void }) {
  const notices: { key: string; text: string; retry?: true }[] = [];
  if (!data.storage) {
    notices.push({
      key: 'storage',
      text: `Model choice is not switched on yet: it needs a database update (migration 0040) that the CRM’s owner applies. Until then Ask AI uses ${data.assistant.configuredModel ?? 'its usual model'} for every question.`,
    });
  }
  if (!data.assistant.enabled) {
    notices.push({
      key: 'off',
      text: 'Ask AI is off for this site. You can still choose its models; members see them once it is on.',
    });
  }
  if (data.storage && !data.catalogue.available) {
    notices.push({
      key: 'catalogue',
      text: 'The AI Gateway’s list of models could not be loaded just now, so models cannot be changed. Ask AI keeps working with the models below.',
      retry: true,
    });
  }
  if (notices.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {notices.map((notice) => (
        <div
          key={notice.key}
          role="status"
          className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/40 px-4 py-3 text-sm"
        >
          <InfoIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <p className="min-w-0 flex-1">{notice.text}</p>
          {notice.retry ? (
            <Button type="button" variant="outline" size="sm" onClick={onRetry}>
              Try again
            </Button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function ModelId({ id }: { id: string }) {
  return <code className="font-mono text-xs break-all text-muted-foreground">{id}</code>;
}

/** What answers members now: the saved default and list, or the deployment's model. */
function InUse({ data }: { data: AiModelSettingsResponse }) {
  const saved: AiSavedModelSettings | null = data.saved;
  return (
    <Card className="min-w-0 gap-0 py-0">
      <section aria-labelledby="ai-models-in-use-title" className="flex flex-col">
        <div className="crm-card-heading">
          <BotIcon aria-hidden="true" />
          <div className="min-w-0">
            <h2 id="ai-models-in-use-title" className="text-base font-medium">
              Models in use
            </h2>
            <p className="text-xs text-muted-foreground">
              {saved
                ? `Saved ${dateTimeLabel(saved.updatedAt)}`
                : 'Nothing chosen yet: the deployment’s model answers every question'}
            </p>
          </div>
        </div>
        <CardContent className="min-w-0 px-5 py-5">
          {saved ? (
            <ul aria-label="Allowed models" className="m-0 flex list-none flex-col gap-3 p-0">
              {saved.allowedModels.map((model) => (
                <li key={model.id} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="text-sm font-medium">{model.label}</span>
                  {model.id === saved.defaultModel ? (
                    <Badge variant="secondary">Default</Badge>
                  ) : null}
                  <ModelId id={model.id} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm">
              {data.assistant.configuredModel === null ? (
                <span className="text-muted-foreground">No model is configured.</span>
              ) : (
                <>
                  <span className="mr-2">Default</span>
                  <ModelId id={data.assistant.configuredModel} />
                </>
              )}
            </p>
          )}
          {data.assistant.highEffortModel !== null ? (
            <p className="mt-4 text-xs text-muted-foreground">
              {'High effort questions with no model chosen use '}
              <ModelId id={data.assistant.highEffortModel} />
              {'. A model a member picks answers at both levels.'}
            </p>
          ) : null}
          {saved && saved.allowedModels.length === 1 ? (
            <p className="mt-4 text-xs text-muted-foreground">
              With one model there is nothing to pick, so members see no model menu.
            </p>
          ) : null}
        </CardContent>
      </section>
    </Card>
  );
}

/** What an owner should know before allowing a model. */
function Notes({ data }: { data: AiModelSettingsResponse }) {
  return (
    <div className="flex flex-col gap-2 text-xs text-muted-foreground">
      <p>
        Ask AI reads the CRM through tool calls, so every model must support them. The Gateway’s
        list does not say which do: a model that cannot answers with an error rather than without
        the CRM’s data. Check a model’s data handling and price before you allow it.
      </p>
      {data.providers.length > 0 ? (
        <p>
          {'Every model is served only from these hosts: '}
          {data.providers.map((provider, index) => (
            <span key={provider}>
              {index > 0 ? ', ' : null}
              <code className="font-mono">{provider}</code>
            </span>
          ))}
          {'. A model none of them serves fails when it is asked.'}
        </p>
      ) : null}
      <p>Members choose among the allowed models in Ask AI. Daily limits stay the same.</p>
    </div>
  );
}

const price = new Intl.NumberFormat('en-CA', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

/** "US$0.50 in · US$1.50 out per million tokens", or that the list has no price. */
export function priceText(
  model: Pick<AiCatalogueModel, 'inputPricePerMillion' | 'outputPricePerMillion'>,
): string {
  if (model.inputPricePerMillion === null || model.outputPricePerMillion === null)
    return 'No price listed';
  return `${price.format(model.inputPricePerMillion)} in · ${price.format(model.outputPricePerMillion)} out per million tokens`;
}

function matches(model: AiCatalogueModel, query: string): boolean {
  if (query === '') return true;
  const needle = query.toLowerCase();
  return [model.name, model.id, model.vendor].some((text) => text.toLowerCase().includes(needle));
}

/**
 * Edit models: tick up to `maxAllowed` of the catalogue's models, mark one as
 * the default, save. A saved model the catalogue no longer lists is left out
 * and named, so a save never sends an id the server would refuse.
 */
function ModelEditor({
  data,
  onCancel,
  onSave,
}: {
  data: AiModelSettingsResponse;
  onCancel: () => void;
  onSave: (body: { allowedModels: string[]; defaultModel: string }) => Promise<void>;
}) {
  const catalogue = data.catalogue.models;
  const byId = useMemo(() => new Map(catalogue.map((model) => [model.id, model])), [catalogue]);
  const savedIds = data.saved?.allowedModels.map((model) => model.id) ?? [];
  const missing = savedIds.filter((id) => !byId.has(id));
  const [chosen, setChosen] = useState<string[]>(() => {
    const kept = savedIds.filter((id) => byId.has(id));
    if (kept.length > 0) return kept;
    const configured = data.assistant.configuredModel;
    return configured !== null && byId.has(configured) ? [configured] : [];
  });
  const [defaultModel, setDefaultModel] = useState<string | undefined>(() => {
    const saved = data.saved?.defaultModel;
    if (saved !== undefined && byId.has(saved)) return saved;
    const configured = data.assistant.configuredModel;
    return configured !== null && byId.has(configured) ? configured : undefined;
  });
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string>();
  const searchId = useId();
  const full = chosen.length >= data.maxAllowed;
  const shown = catalogue.filter((model) => matches(model, query.trim()));
  const effectiveDefault =
    defaultModel !== undefined && chosen.includes(defaultModel) ? defaultModel : chosen[0];

  function toggle(id: string, on: boolean): void {
    setFailure(undefined);
    setChosen((current) =>
      on
        ? current.includes(id) || current.length >= data.maxAllowed
          ? current
          : [...current, id]
        : current.filter((entry) => entry !== id),
    );
  }

  async function save(): Promise<void> {
    if (effectiveDefault === undefined || chosen.length === 0) return;
    setSaving(true);
    setFailure(undefined);
    try {
      await onSave({ allowedModels: chosen, defaultModel: effectiveDefault });
    } catch (error) {
      const modelId =
        error instanceof BackendError &&
        error.code === 'invalid_request' &&
        error.details?.['reason'] === 'model_unavailable' &&
        typeof error.details['modelId'] === 'string'
          ? error.details['modelId']
          : undefined;
      setFailure(
        modelId !== undefined
          ? `The AI Gateway no longer offers ${byId.get(modelId)?.name ?? modelId}. Untick it and save again.`
          : describeError(error, 'save the models'),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby="ai-models-edit-title" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id="ai-models-edit-title" className="text-base font-medium">
          Edit models
        </h2>
        <p className="text-sm text-muted-foreground">
          {`Tick up to ${String(data.maxAllowed)} models members may choose, then pick the default.`}
        </p>
      </div>

      {missing.length > 0 ? (
        <p role="status" className="text-sm text-muted-foreground">
          {`No longer in the AI Gateway’s list, so left out: ${missing.join(', ')}.`}
        </p>
      ) : null}

      <fieldset className="m-0 flex min-w-0 flex-col gap-2 rounded-lg border p-4">
        <legend className="px-1 text-sm font-medium">Default model</legend>
        {chosen.length === 0 ? (
          <p className="text-sm text-muted-foreground">Tick at least one model below.</p>
        ) : (
          chosen.map((id) => {
            const model = byId.get(id);
            return (
              <label key={id} className="flex min-w-0 cursor-pointer items-center gap-3 text-sm">
                <input
                  type="radio"
                  name="ai-default-model"
                  value={id}
                  checked={effectiveDefault === id}
                  onChange={() => setDefaultModel(id)}
                  className="size-4 shrink-0 accent-primary"
                />
                <span className="min-w-0 break-words">{model?.name ?? id}</span>
              </label>
            );
          })
        )}
      </fieldset>

      <div className="flex flex-col gap-2">
        <label htmlFor={searchId} className="text-sm font-medium">
          Search models
        </label>
        <div className="relative">
          <SearchIcon
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            id={searchId}
            type="search"
            value={query}
            placeholder="Name, vendor or id"
            onChange={(event) => setQuery(event.target.value)}
            className="pl-9"
          />
        </div>
        <p aria-live="polite" className="text-xs text-muted-foreground">
          {`${String(chosen.length)} of ${String(data.maxAllowed)} chosen · ${String(shown.length)} shown`}
        </p>
      </div>

      <ul
        aria-label="AI Gateway models"
        className="m-0 flex max-h-[28rem] list-none flex-col overflow-y-auto rounded-lg border p-0"
      >
        {shown.length === 0 ? (
          <li className="px-4 py-3 text-sm text-muted-foreground">No model matches the search.</li>
        ) : (
          shown.map((model) => {
            const checked = chosen.includes(model.id);
            const boxId = `ai-model-${model.id}`;
            return (
              <li key={model.id} className="border-b last:border-0">
                <div
                  className={cn(
                    'flex min-w-0 items-start gap-3 px-4 py-3',
                    checked && 'bg-muted/40',
                  )}
                >
                  <Checkbox
                    id={boxId}
                    checked={checked}
                    disabled={!checked && full}
                    onCheckedChange={(state) => toggle(model.id, state === true)}
                    className="mt-0.5"
                  />
                  <label
                    htmlFor={boxId}
                    className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5"
                  >
                    <span className="flex flex-wrap items-baseline gap-x-2 text-sm">
                      <span className="font-medium">{model.name}</span>
                      <span className="text-xs text-muted-foreground">{model.vendor}</span>
                    </span>
                    {model.description ? (
                      <span className="text-xs text-muted-foreground">{model.description}</span>
                    ) : null}
                    <span className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                      <span>{priceText(model)}</span>
                      <ModelId id={model.id} />
                    </span>
                  </label>
                </div>
              </li>
            );
          })
        )}
      </ul>

      {failure ? (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={saving || chosen.length === 0} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save models'}
        </Button>
        <Button type="button" variant="outline" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </section>
  );
}
