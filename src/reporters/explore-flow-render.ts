import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { ExploreReport } from '../agent/page-explorer.js';
import { buildActionOutcome } from '../agent/explore-outcome.js';
import { formatExplorePlanLabel } from '../agent/explore-planner.js';
import {
  escapeHtml,
  renderScreenshotContent,
} from './report-utils.js';

export const exploreFlowReportStyles = `
  .explore-flow { margin-top: 8px; }
  .explore-flow summary { cursor: pointer; font-weight: 600; font-size: 13px; color: #334155; }
  .explore-flow-link { display: inline-block; margin-top: 8px; font-size: 12px; color: #2563eb; }
  .explore-step { border: 1px solid #e2e8f0; border-radius: 10px; margin: 10px 0; overflow: hidden; background: #fff; }
  .explore-step.pass { border-left: 4px solid #10b981; }
  .explore-step.fail { border-left: 4px solid #ef4444; }
  .explore-step.skip { border-left: 4px solid #94a3b8; }
  .explore-step.done { border-left: 4px solid #3b82f6; }
  .explore-step-head { display: flex; gap: 10px; align-items: center; padding: 10px 12px; background: #f8fafc; border-bottom: 1px solid #e2e8f0; flex-wrap: wrap; }
  .explore-step-no { font-weight: 700; color: #64748b; min-width: 24px; }
  .explore-step-title { flex: 1; font-size: 13px; font-weight: 600; }
  .explore-step-badge { font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 999px; text-transform: uppercase; }
  .explore-step-badge.pass { background: #d1fae5; color: #047857; }
  .explore-step-badge.fail { background: #fee2e2; color: #b91c1c; }
  .explore-step-badge.skip { background: #f1f5f9; color: #64748b; }
  .explore-step-body { padding: 12px; font-size: 13px; }
  .explore-section { margin-bottom: 12px; }
  .explore-section h5 { margin: 0 0 6px; font-size: 12px; color: #64748b; text-transform: uppercase; letter-spacing: 0.04em; }
  .explore-outcome { margin: 0; padding: 8px 10px; border-radius: 8px; background: #f0fdf4; color: #166534; }
  .explore-outcome.fail { background: #fef2f2; color: #b91c1c; }
  .explore-outcome.skip { background: #f8fafc; color: #64748b; }
  .explore-url { margin: 4px 0 0; font-size: 12px; color: #64748b; word-break: break-all; }
  .explore-interactives-mini { width: 100%; border-collapse: collapse; font-size: 12px; }
  .explore-interactives-mini th, .explore-interactives-mini td { border: 1px solid #e2e8f0; padding: 6px 8px; text-align: left; vertical-align: top; }
  .explore-interactives-mini th { background: #f8fafc; }
  .kind-pill { display: inline-block; padding: 1px 6px; border-radius: 4px; background: #e2e8f0; font-size: 10px; font-weight: 600; }
  .explore-shots { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; }
  .explore-shot-label { font-size: 11px; color: #64748b; margin-bottom: 4px; }
  .explore-shot img { max-width: 100%; max-height: 180px; border: 1px solid #e2e8f0; border-radius: 6px; }
  .explore-feedback { margin: 6px 0 0; padding-left: 16px; color: #475569; }
  .explore-feedback li { margin-bottom: 4px; }
  td.explore-detail-cell { min-width: 320px; max-width: 640px; }
`;

const kindBadge = (kind: string) =>
  `<span class="kind-pill">${escapeHtml(kind)}</span>`;

const resolveOutcome = (action: ExploreReport['actions'][number]) => {
  if (action.outcome) return action.outcome;

  const urlAfter = action.urlAfter ?? '';
  const urlBefore = action.urlBefore ?? urlAfter;

  if (urlAfter || action.action === 'scroll' || action.action === 'fill' || action.action === 'click') {
    return buildActionOutcome({
      action: action.action,
      plan: action.plan,
      element: action.element,
      success: action.success,
      reason: action.reason,
      urlBefore,
      urlAfter,
      feedback: action.feedback ?? [],
    });
  }

  if (action.success) {
    return action.reason ? `操作完成 — ${action.reason}` : '操作完成';
  }
  return action.reason ? `操作失败 — ${action.reason}` : '操作失败';
};

const renderInteractivesMini = (
  interactives: ExploreReport['actions'][number]['interactives']
) => {
  if (!interactives?.interactives?.length) {
    return '<p style="color:#94a3b8;margin:0">未记录可交互元素</p>';
  }
  const rows = interactives.interactives
    .map(item => {
      const dis = item.disabled ? ' <em style="color:#94a3b8">disabled</em>' : '';
      return `<tr>
        <td>${kindBadge(item.kind)}</td>
        <td><strong>${escapeHtml(item.label)}</strong>${dis}</td>
        <td>${escapeHtml(item.suggestedAction ?? '-')}</td>
      </tr>`;
    })
    .join('');
  return `<p style="margin:0 0 8px;color:#334155">${escapeHtml(interactives.pageSummary)}</p>
    <table class="explore-interactives-mini">
      <thead><tr><th>类型</th><th>元素</th><th>建议</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
};

const relShot = (reportDir: string, absPath?: string) => {
  if (!absPath) return '';
  return relative(reportDir, absPath).split('\\').join('/');
};

const renderActionOperation = (action: ExploreReport['actions'][number]) => {
  if (action.plan) return escapeHtml(formatExplorePlanLabel(action.plan));
  if (action.element) {
    return escapeHtml(`${action.action} ${action.element.role}「${action.element.name}」`);
  }
  return escapeHtml(action.action);
};

export const renderExploreActionCard = (
  action: ExploreReport['actions'][number],
  idx: number,
  reportDir: string
) => {
  const stepNo = idx + 1;
  const statusClass =
    action.action === 'skip'
      ? 'skip'
      : action.action === 'done'
        ? 'done'
        : action.success
          ? 'pass'
          : 'fail';
  const badgeClass = action.action === 'skip' ? 'skip' : action.success ? 'pass' : 'fail';
  const outcome = resolveOutcome(action);
  const outcomeClass =
    action.action === 'skip' ? 'skip' : action.success ? '' : 'fail';

  const beforeHref = relShot(reportDir, action.screenshot);
  const afterHref = relShot(reportDir, action.screenshotAfter);
  const shots =
    beforeHref || afterHref
      ? `<div class="explore-shots">
          ${beforeHref ? `<div><div class="explore-shot-label">操作前</div><div class="explore-shot">${renderScreenshotContent(beforeHref, `Step ${stepNo} before`)}</div></div>` : ''}
          ${afterHref ? `<div><div class="explore-shot-label">操作后</div><div class="explore-shot">${renderScreenshotContent(afterHref, `Step ${stepNo} after`)}</div></div>` : ''}
        </div>`
      : '';

  const urlLine =
    action.urlBefore && action.urlAfter && action.urlBefore !== action.urlAfter
      ? `<p class="explore-url">URL: ${escapeHtml(action.urlBefore)} → ${escapeHtml(action.urlAfter)}</p>`
      : action.urlAfter
        ? `<p class="explore-url">URL: ${escapeHtml(action.urlAfter)}</p>`
        : '';

  const feedback =
    action.feedback && action.feedback.length
      ? `<ul class="explore-feedback">${action.feedback.map(f => `<li>${escapeHtml(f)}</li>`).join('')}</ul>`
      : '';

  const thinking = action.thinking
    ? `<p style="margin:0 0 8px;color:#475569">${escapeHtml(action.thinking)}</p>`
    : '';

  return `<article class="explore-step ${statusClass}">
    <header class="explore-step-head">
      <span class="explore-step-no">#${stepNo}</span>
      <span class="explore-step-title">${renderActionOperation(action)}</span>
      <span class="explore-step-badge ${badgeClass}">${escapeHtml(action.action)}</span>
    </header>
    <div class="explore-step-body">
      ${thinking}
      <div class="explore-section">
        <h5>识别到的可交互元素</h5>
        ${renderInteractivesMini(action.interactives)}
      </div>
      <div class="explore-section">
        <h5>操作结果</h5>
        <p class="explore-outcome ${outcomeClass}">${escapeHtml(outcome)}</p>
        ${urlLine}
        ${feedback}
      </div>
      ${shots ? `<div class="explore-section"><h5>截图对比</h5>${shots}</div>` : ''}
    </div>
  </article>`;
};

export const renderExploreFlowHtml = (
  report: ExploreReport,
  reportDir: string,
  options: { compact?: boolean; detailHref?: string; exploreReportDir?: string } = {}
) => {
  if (!report.actions.length) return '';

  const flowReportDir = options.exploreReportDir
    ? join(reportDir, options.exploreReportDir)
    : reportDir;

  const cards = report.actions
    .map((action, idx) => renderExploreActionCard(action, idx, flowReportDir))
    .join('\n');

  const summary = `[${report.aiMode ? 'AI 逐步思考' : '队列扫描'}] 发现 ${report.discovered} 个元素，尝试 ${report.attempted} 次，成功 ${report.succeeded} 次，跳过 ${report.skipped} 次`;
  const detailLink = options.detailHref
    ? `<a class="explore-flow-link" href="${escapeHtml(options.detailHref)}" target="_blank">查看完整探索报告 →</a>`
    : '';

  if (options.compact) {
    return `<details class="explore-flow">
      <summary>${escapeHtml(summary)}</summary>
      ${cards}
      ${detailLink}
    </details>`;
  }

  return `<section class="explore-flow">
    <p style="margin:0 0 10px;font-size:13px;color:#334155">${escapeHtml(summary)}</p>
    ${cards}
    ${detailLink}
  </section>`;
};

export const loadExploreReport = (reportDir: string, exploreSubDir: string): ExploreReport | null => {
  const jsonPath = join(reportDir, exploreSubDir, 'explore-report.json');
  if (!existsSync(jsonPath)) return null;
  try {
    return JSON.parse(readFileSync(jsonPath, 'utf8')) as ExploreReport;
  } catch {
    return null;
  }
};

export const exploreSubDirForStep = (stepIndex: number) =>
  `explore-after-step-${String(stepIndex + 1).padStart(2, '0')}`;
