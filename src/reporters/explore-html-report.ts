import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExploreReport } from '../agent/page-explorer.js';
import { formatExplorePlanLabel } from '../agent/explore-planner.js';
import {
  escapeHtml,
  renderScreenshotToggleButton,
  screenshotGalleryReportScript,
  screenshotGalleryReportStyles,
} from './report-utils.js';
import {
  exploreFlowReportStyles,
  renderExploreActionCard,
} from './explore-flow-render.js';

export type ExploreHtmlReportOptions = {
  title?: string;
  url?: string;
  finishedAt?: string;
};

export const writeExploreHtmlReport = (
  report: ExploreReport,
  reportDir: string,
  options: ExploreHtmlReportOptions = {}
): string => {
  const reportPath = join(reportDir, 'index.html');
  const title = options.title ?? '启发式探索报告';
  const finishedAt = options.finishedAt ?? new Date().toISOString();
  const summary = `[${report.aiMode ? 'AI 逐步思考' : '队列扫描'}] 发现 ${report.discovered} 个可交互元素，尝试 ${report.attempted} 次，成功 ${report.succeeded} 次，跳过 ${report.skipped} 次`;

  const stepSections = report.actions
    .map((action, idx) => renderExploreActionCard(action, idx, reportDir))
    .join('\n');

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; margin: 0; background: #f1f5f9; color: #0f172a; }
    .container { max-width: 1100px; margin: 0 auto; padding: 24px 20px 48px; }
    h1 { margin: 0 0 8px; font-size: 1.5rem; }
    .meta { color: #64748b; font-size: 14px; margin-bottom: 20px; }
    .meta a { color: #2563eb; word-break: break-all; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 20px; }
    .stat { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 14px 16px; }
    .stat-label { font-size: 12px; color: #64748b; text-transform: uppercase; letter-spacing: 0.04em; }
    .stat-value { font-size: 1.4rem; font-weight: 700; margin-top: 4px; }
    .stat-value.mode { font-size: 0.95rem; font-weight: 600; }
    .summary-bar { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 12px 16px; margin-bottom: 16px; font-size: 14px; }
    .screenshot-toolbar { margin-bottom: 20px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    ${exploreFlowReportStyles}
    ${screenshotGalleryReportStyles}
    .explore-shot img { max-height: 480px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>${escapeHtml(title)}</h1>
    <p class="meta">
      ${options.url ? `<strong>URL:</strong> <a href="${escapeHtml(options.url)}" target="_blank">${escapeHtml(options.url)}</a><br/>` : ''}
      <strong>开始:</strong> ${escapeHtml(report.startUrl)}<br/>
      <strong>结束:</strong> ${escapeHtml(report.endUrl)}<br/>
      <strong>完成时间:</strong> ${escapeHtml(finishedAt)}
    </p>

    <div class="stats">
      <div class="stat"><div class="stat-label">发现元素</div><div class="stat-value">${report.discovered}</div></div>
      <div class="stat"><div class="stat-label">尝试</div><div class="stat-value">${report.attempted}</div></div>
      <div class="stat"><div class="stat-label">成功</div><div class="stat-value">${report.succeeded}</div></div>
      <div class="stat"><div class="stat-label">跳过</div><div class="stat-value">${report.skipped}</div></div>
      <div class="stat"><div class="stat-label">模式</div><div class="stat-value mode">${report.aiMode ? 'AI 逐步思考' : '队列扫描'}</div></div>
    </div>

    <div class="summary-bar">${escapeHtml(summary)}</div>

    <div class="screenshot-toolbar">
      ${renderScreenshotToggleButton()}
      <span id="screenshot-toggle-status" class="screenshot-toggle-status"></span>
    </div>

    <div class="steps">${stepSections || '<p style="color:#94a3b8">无步骤记录</p>'}</div>
  </div>
  ${screenshotGalleryReportScript}
</body>
</html>`;

  mkdirSync(reportDir, { recursive: true });
  writeFileSync(reportPath, html);
  return reportPath;
};

// Re-export for callers that format labels
export { formatExplorePlanLabel };
