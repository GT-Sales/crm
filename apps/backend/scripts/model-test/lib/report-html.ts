import {
  CATEGORIES,
  CATEGORY_LABELS,
  CATEGORY_WEIGHTS,
  promptTurns,
  type PromptFile,
} from './fixtures.js';
import { judgeText } from './judge.js';
import type { PromptResult, RunFile } from './results.js';
import {
  finalScore,
  presentCategories,
  recommend,
  scoreModel,
  type ModelScores,
  type Recommendation,
} from './scoring.js';

/**
 * The model test report: one self-contained HTML file (inline CSS and a
 * little inline JS, no network), light and dark, readable at phone width.
 * Everything shown comes from the results file, escaped.
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function percent(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(1)}%`;
}

function seconds(ms: number | null): string {
  return ms === null ? '—' : `${(ms / 1000).toFixed(1)} s`;
}

function usd(value: number | null): string {
  if (value === null) return '—';
  return value < 0.01 ? `$${value.toFixed(5)}` : `$${value.toFixed(4)}`;
}

function scoreClass(value: number | null): string {
  if (value === null) return 'na';
  if (value >= 80) return 'good';
  if (value >= 60) return 'fair';
  return 'poor';
}

const STYLE = `
:root{--bg:#f7f7f5;--panel:#fff;--text:#1d1d1b;--muted:#5f5f5a;--line:#e2e1dc;--accent:#2f5bd3;
--good:#1f7a4a;--good-bg:#e3f4ea;--fair:#8a5a00;--fair-bg:#fbf0d9;--poor:#b3261e;--poor-bg:#fbe5e3;--na:#767670;--na-bg:#efefec}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--panel:#1d1d1b;--text:#ecebe6;--muted:#a3a29b;--line:#33322f;--accent:#8fb0ff;
--good:#7fd6a3;--good-bg:#173626;--fair:#f0c46a;--fair-bg:#3a2e12;--poor:#ff9a90;--poor-bg:#3d1a17;--na:#a3a29b;--na-bg:#2a2a27}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1180px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:1.6rem;margin:0 0 4px}h2{font-size:1.2rem;margin:36px 0 12px}h3{font-size:1rem;margin:0 0 8px}
.muted{color:var(--muted)}.small{font-size:.85rem}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px}
.picks{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
.pick .model{font-size:1.15rem;font-weight:650;word-break:break-word;margin:4px 0}
.pick .tag{text-transform:uppercase;letter-spacing:.06em;font-size:.75rem;color:var(--accent);font-weight:650}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;border:1px solid var(--line);border-radius:12px;background:var(--panel)}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}
th:first-child,td:first-child{text-align:left;position:sticky;left:0;background:var(--panel);white-space:normal;min-width:150px}
thead th{font-size:.8rem;color:var(--muted);font-weight:600;vertical-align:bottom;white-space:normal;word-break:break-word;min-width:92px}
tr.total td{font-weight:700}
.chip{display:inline-block;padding:1px 8px;border-radius:999px;font-size:.82rem;font-weight:600}
.good{color:var(--good);background:var(--good-bg)}.fair{color:var(--fair);background:var(--fair-bg)}
.poor{color:var(--poor);background:var(--poor-bg)}.na{color:var(--na);background:var(--na-bg)}
.filters{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 12px}
select{font:inherit;color:var(--text);background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:6px 8px;max-width:100%}
details.prompt{background:var(--panel);border:1px solid var(--line);border-radius:12px;margin:0 0 10px}
details.prompt>summary{cursor:pointer;padding:12px 14px;list-style:none}
details.prompt>summary::-webkit-details-marker{display:none}
details.prompt[open]>summary{border-bottom:1px solid var(--line)}
.body{padding:12px 14px}
.answers{display:grid;gap:10px;grid-template-columns:repeat(auto-fill,minmax(300px,1fr))}
.answer{border:1px solid var(--line);border-radius:10px;padding:10px;min-width:0}
.answer header{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:6px}
.answer .name{font-weight:650;word-break:break-word;margin-right:auto}
pre{white-space:pre-wrap;word-break:break-word;font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;margin:6px 0;max-height:420px;overflow:auto}
ul.checks{margin:6px 0;padding-left:18px}ul.checks li.fail{color:var(--poor)}
.note{border-left:3px solid var(--line);padding-left:8px;margin:4px 0}
@media (max-width:520px){main{padding:16px 16px 48px}.answers{grid-template-columns:1fr}h1{font-size:1.35rem}}
`;

const SCRIPT = `
(function(){var c=document.getElementById('f-category'),m=document.getElementById('f-model');
function apply(){var cv=c.value,mv=m.value;document.querySelectorAll('details.prompt').forEach(function(d){
d.hidden=!!cv&&d.dataset.category!==cv;});document.querySelectorAll('.answer').forEach(function(a){
a.hidden=!!mv&&a.dataset.model!==mv;});}c.addEventListener('change',apply);m.addEventListener('change',apply);})();
`;

function pickCard(tag: string, model: string | null, why: string, extra: string): string {
  return `<div class="panel pick"><div class="tag">${escapeHtml(tag)}</div><div class="model">${escapeHtml(
    model ?? 'No model qualifies',
  )}</div><div class="small muted">${escapeHtml(why)}</div>${extra}</div>`;
}

function scoresTable(models: readonly string[], scores: readonly ModelScores[]): string {
  const head = models.map((model) => `<th>${escapeHtml(model)}</th>`).join('');
  const rows = CATEGORIES.map((category) => {
    const cells = scores
      .map((score) => {
        const value = score.categories[category];
        return `<td><span class="chip ${scoreClass(value)}">${percent(value)}</span></td>`;
      })
      .join('');
    return `<tr><td>${escapeHtml(CATEGORY_LABELS[category])} <span class="muted small">${Math.round(
      CATEGORY_WEIGHTS[category] * 100,
    )}%</span></td>${cells}</tr>`;
  }).join('');
  const weighted = scores
    .map(
      (score) =>
        `<td><span class="chip ${scoreClass(score.weighted)}">${percent(score.weighted)}</span></td>`,
    )
    .join('');
  const high = scores.map((score) => `<td>${percent(score.reasoningHigh)}</td>`).join('');
  const pending = scores.map((score) => `<td>${score.pending}</td>`).join('');
  return `<div class="scroll"><table><thead><tr><th>Category (weight)</th>${head}</tr></thead><tbody>${rows}
<tr class="total"><td>Weighted score</td>${weighted}</tr>
<tr><td>Reasoning at High effort</td>${high}</tr>
<tr><td class="muted">Prompts not yet answered</td>${pending}</tr></tbody></table></div>`;
}

function safetyTable(
  models: readonly string[],
  scores: readonly ModelScores[],
  prompts: PromptFile,
): string {
  const safety = prompts.prompts.filter((prompt) => prompt.category === 'safety');
  const head = models.map((model) => `<th>${escapeHtml(model)}</th>`).join('');
  const rows = safety
    .map((prompt) => {
      const cells = scores
        .map((score) => {
          const state = score.safety.items[prompt.id] ?? 'missing';
          const css = state === 'pass' ? 'good' : state === 'missing' ? 'na' : 'poor';
          return `<td><span class="chip ${css}">${state}</span></td>`;
        })
        .join('');
      return `<tr><td>${escapeHtml(prompt.id)} <span class="muted small">${escapeHtml(
        (prompt.text ?? '').slice(0, 70),
      )}</span></td>${cells}</tr>`;
    })
    .join('');
  const gate = scores
    .map(
      (score) =>
        `<td><span class="chip ${score.safety.gate ? 'good' : 'poor'}">${score.safety.gate ? 'passed' : 'ruled out'}</span></td>`,
    )
    .join('');
  return `<div class="scroll"><table><thead><tr><th>Safety prompt</th>${head}</tr></thead><tbody>${rows}
<tr class="total"><td>Gate</td>${gate}</tr></tbody></table></div>`;
}

function speedTable(models: readonly string[], scores: readonly ModelScores[]): string {
  const head = models.map((model) => `<th>${escapeHtml(model)}</th>`).join('');
  const row = (label: string, cell: (score: ModelScores) => string) =>
    `<tr><td>${label}</td>${scores.map((score) => `<td>${cell(score)}</td>`).join('')}</tr>`;
  return `<div class="scroll"><table><thead><tr><th>Per turn</th>${head}</tr></thead><tbody>
${row('Average answer time', (score) => seconds(score.avgTurnMs))}
${row('Average cost (list price)', (score) => usd(score.avgTurnCostUsd))}
${row('Total cost of this run', (score) => usd(score.totalCostUsd))}
</tbody></table></div>`;
}

function answerCard(result: PromptResult, judged: boolean): string {
  const final = finalScore(result, judged);
  const css = final === 2 ? 'good' : final === 1 ? 'fair' : 'poor';
  const failed = result.checks.filter((check) => !check.pass);
  const checks = result.checks.length
    ? `<ul class="checks">${result.checks
        .map(
          (check) =>
            `<li class="${check.pass ? '' : 'fail'}">${check.pass ? '✓' : '✗'} ${escapeHtml(check.type)}${
              check.detail ? ` <span class="muted">(${escapeHtml(check.detail)})</span>` : ''
            }</li>`,
        )
        .join('')}</ul>`
    : '';
  const judges = (result.judges ?? [])
    .map(
      (judge) =>
        `<div class="note small"><strong>${escapeHtml(judge.judge)}</strong> ${Object.entries(
          judge.criteria,
        )
          .map(([key, value]) => `${escapeHtml(key)} ${value}`)
          .join(' · ')}<br>${escapeHtml(judge.note)}</div>`,
    )
    .join('');
  const earlier =
    result.turns.length > 1
      ? `<details><summary class="small muted">Earlier turns</summary>${result.turns
          .slice(0, -1)
          .map(
            (turn) =>
              `<div class="small"><strong>${escapeHtml(turn.text)}</strong><pre>${escapeHtml(
                turn.capture.text || '(no text)',
              )}</pre></div>`,
          )
          .join('')}</details>`
      : '';
  const tools = result.turns.at(-1)?.capture.tools ?? [];
  return `<div class="answer" data-model="${escapeHtml(result.model)}"><header><span class="name">${escapeHtml(
    result.model,
  )}${result.effort === 'high' ? ' · High' : ''}</span><span class="chip ${css}">${final}/2</span>
<span class="chip na">auto ${result.autoScore}</span>${
    result.judgeMean === undefined || result.judgeMean === null
      ? ''
      : `<span class="chip na">judges ${result.judgeMean.toFixed(2)}</span>`
  }</header>
<div class="small muted">${escapeHtml(result.outcome)}${result.failureCode ? ` · ${escapeHtml(result.failureCode)}` : ''} · ${seconds(
    result.durationMs,
  )} · ${usd(result.costUsd)}${result.usage ? ` · ${result.usage.inputTokens}/${result.usage.outputTokens} tokens` : ''}${
    tools.length ? ` · tools: ${escapeHtml(tools.join(', '))}` : ''
  }</div>
${earlier}<pre>${escapeHtml(judgeText(result))}</pre>${failed.length || result.checks.length ? checks : ''}${judges}</div>`;
}

export function renderReport(run: RunFile, prompts: PromptFile): string {
  const present = presentCategories(run);
  const scores = run.models.map((model) => scoreModel(run, model, prompts.prompts, present));
  const recommendation: Recommendation = recommend(scores);
  const byModel = new Map(scores.map((score) => [score.model, score]));
  const pickExtra = (model: string | null) => {
    const score = model ? byModel.get(model) : undefined;
    return score
      ? `<div class="small">Weighted ${percent(score.weighted)} · reasoning ${percent(
          score.reasoningDeep,
        )} · ${seconds(score.avgTurnMs)} · ${usd(score.avgTurnCostUsd)} per turn</div>`
      : '';
  };
  const absent = CATEGORIES.filter((category) => !present.has(category));
  const notes = [
    ...run.notes,
    ...(absent.length
      ? [
          `Not scored (no answers): ${absent.map((category) => CATEGORY_LABELS[category]).join(', ')}; the weights are renormalised over the rest.`,
        ]
      : []),
    ...(run.highModels
      ? [`High effort pass: ${run.highModels.models.join(', ')} (${run.highModels.basis}).`]
      : []),
  ];

  const promptSections = prompts.prompts
    .map((prompt) => {
      const results = run.results
        .filter((result) => result.promptId === prompt.id)
        .sort((a, b) => a.model.localeCompare(b.model) || a.effort.localeCompare(b.effort));
      if (results.length === 0) return '';
      const turns = promptTurns(prompt);
      const asked = turns
        .map(
          (turn, index) =>
            `<div>${turns.length > 1 ? `${index + 1}. ` : ''}${escapeHtml(turn.text)}${
              turn.attachments
                ? ` <span class="muted small">[${escapeHtml(turn.attachments.join(', '))}]</span>`
                : ''
            }</div>`,
        )
        .join('');
      return `<details class="prompt" data-category="${prompt.category}"><summary><strong>${escapeHtml(
        prompt.id,
      )}</strong> <span class="muted small">${escapeHtml(CATEGORY_LABELS[prompt.category])}${
        prompt.account === 'leads' ? ' · Leads-role account' : ''
      }${prompt.judge ? ' · judged' : ''}</span><div>${escapeHtml(turns.at(-1)?.text ?? '')}</div></summary>
<div class="body"><div class="small">${asked}</div>${
        prompt.facts ? `<p class="small muted">Facts: ${escapeHtml(prompt.facts)}</p>` : ''
      }<div class="answers">${results.map((result) => answerCard(result, prompt.judge)).join('')}</div></div></details>`;
    })
    .join('');

  const categoryOptions = [...CATEGORIES, 'safety' as const]
    .map(
      (category) => `<option value="${category}">${escapeHtml(CATEGORY_LABELS[category])}</option>`,
    )
    .join('');
  const modelOptions = run.models
    .map((model) => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`)
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>Ask AI model test</title><style>${STYLE}</style></head>
<body><main>
<h1>Ask AI model test</h1>
<div class="muted small">Site ${escapeHtml(run.site.name)} (${escapeHtml(run.site.slug)}) · prompts v${run.promptsVersion} · started ${escapeHtml(
    run.startedAt,
  )} · updated ${escapeHtml(run.updatedAt)} · ${run.models.length} models · ${run.results.length} answers</div>
<h2>Recommendation</h2>
<div class="picks">
${pickCard('Default', recommendation.default, recommendation.why.default, pickExtra(recommendation.default))}
${pickCard('Deep (High effort)', recommendation.deep, recommendation.why.deep, pickExtra(recommendation.deep))}
${pickCard('Fast', recommendation.fast, recommendation.why.fast, pickExtra(recommendation.fast))}
</div>
${
  recommendation.ruledOut.length
    ? `<p class="small">Ruled out by the safety gate: ${recommendation.ruledOut.map(escapeHtml).join(', ')}.</p>`
    : '<p class="small">No model failed the safety gate.</p>'
}
${notes.length ? `<ul class="small muted">${notes.map((note) => `<li>${escapeHtml(note)}</li>`).join('')}</ul>` : ''}
<h2>Scores</h2>${scoresTable(run.models, scores)}
<h2>Safety gate</h2>${safetyTable(run.models, scores, prompts)}
<h2>Speed and cost</h2>${speedTable(run.models, scores)}
<p class="small muted">Speed and cost are measured, not scored. Cost is the turn’s tokens at the Gateway catalogue’s list price.</p>
<h2>Answers</h2>
<div class="filters"><select id="f-category" aria-label="Category"><option value="">All categories</option>${categoryOptions}</select>
<select id="f-model" aria-label="Model"><option value="">All models</option>${modelOptions}</select></div>
${promptSections}
</main><script>${SCRIPT}</script></body></html>
`;
}
