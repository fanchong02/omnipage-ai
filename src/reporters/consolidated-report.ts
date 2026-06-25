import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { ScenarioResult } from '../types.js';
import {
  browserLogsReportStyles,
  dedupeBrowserLogs,
  escapeHtml,
  isAbnormalBrowserLog,
  renderBrowserLogsHtml,
  renderScreenshotContent,
  renderScreenshotToggleButton,
  renderVisualAnalysisHtml,
  screenshotGalleryReportScript,
  screenshotGalleryReportStyles,
  visualAnalysisReportStyles,
} from './report-utils.js';

export type ConsolidatedCaseEntry = {
  path: string;
  priority?: string;
  category?: string;
  result: ScenarioResult;
};

export type ConsolidatedReportInput = {
  suite: string;
  description?: string;
  startedAt: string;
  finishedAt: string;
  cases: ConsolidatedCaseEntry[];
};

const relPath = (fromDir: string, targetPath: string) =>
  relative(fromDir, targetPath).split('\\').join('/');

const renderStepLogsPreview = (logs: ScenarioResult['steps'][number]['browserLogs']) => {
  const abnormal = dedupeBrowserLogs((logs ?? []).filter(isAbnormalBrowserLog));
  if (abnormal.length === 0) return '-';
  return `<span class="log-count">${abnormal.length}</span> ${escapeHtml(abnormal[0]?.message ?? '')}`;
};

const renderSteps = (result: ScenarioResult, reportDir: string) =>
  result.steps
    .map(step => {
      const statusClass = step.status === 'passed' ? 'pass' : 'fail';
      const screenshot = step.screenshot
        ? renderScreenshotContent(
            relPath(reportDir, step.screenshot),
            `Step ${step.index + 1} screenshot`
          )
        : '-';
      const visual = step.visualAnalysis
        ? `<div class="step-visual ${step.visualAnalysis.hasVisualIssue ? 'bad' : ''}">${escapeHtml(step.visualAnalysis.summary)}</div>`
        : '-';
      return `<tr class="${statusClass}">
        <td>${step.index + 1}</td>
        <td><pre>${escapeHtml(JSON.stringify(step.step))}</pre></td>
        <td>${step.status}</td>
        <td>${escapeHtml(step.message ?? '')}</td>
        <td class="step-logs">${renderStepLogsPreview(step.browserLogs)}</td>
        <td class="step-visual-cell">${visual}</td>
        <td>${step.durationMs}ms</td>
        <td class="screenshot-cell">${screenshot}</td>
      </tr>`;
    })
    .join('\n');

export const writeConsolidatedReport = (
  input: ConsolidatedReportInput,
  outputDir: string
): { htmlPath: string; jsonPath: string } => {
  mkdirSync(outputDir, { recursive: true });

  const passed = input.cases.filter(c => c.result.status === 'passed').length;
  const failed = input.cases.length - passed;
  const overallStatus = failed === 0 ? 'passed' : 'failed';

  const caseSections = input.cases
    .map(({ path, priority, category, result }) => {
      const openAttr = result.status === 'failed' ? ' open' : '';
      const detailReport = relPath(outputDir, join(result.reportDir, 'index.html'));
      return `<details class="case ${result.status}"${openAttr}>
  <summary>
    <span class="case-icon">${result.status === 'passed' ? '✓' : '✗'}</span>
    <span class="case-name">${escapeHtml(result.name)}</span>
    <span class="case-path">${escapeHtml(path)}</span>
    <span class="case-meta">${escapeHtml(priority ?? '-')} / ${escapeHtml(category ?? '-')}</span>
    <span class="case-status ${result.status}">${result.status.toUpperCase()}</span>
  </summary>
  <div class="case-body">
    <p>
      <a href="${escapeHtml(detailReport)}">单用例报告</a>
      · ${escapeHtml(result.startedAt)} → ${escapeHtml(result.finishedAt)}
    </p>
    <table>
      <thead>
        <tr><th>#</th><th>Step</th><th>Status</th><th>Message</th><th>Console</th><th>Visual</th><th>Duration</th><th>Screenshot</th></tr>
      </thead>
      <tbody>${renderSteps(result, outputDir)}</tbody>
    </table>
    ${renderVisualAnalysisHtml(result.visualReview?.analysis, {
      title: '场景 AI 视觉审查',
      screenshotHref: result.visualReview?.screenshot
        ? relPath(outputDir, result.visualReview.screenshot)
        : undefined,
    })}
    ${renderBrowserLogsHtml(result.browserLogs, { title: '异常控制台日志' })}
  </div>
</details>`;
    })
    .join('\n');

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>QA Report — ${escapeHtml(input.suite)}</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; margin: 0; background: #f4f5f7; color: #1a1a1a; }
    header { background: #fff; border-bottom: 1px solid #ddd; padding: 20px 24px; }
    h1 { margin: 0 0 4px; font-size: 22px; }
    .desc { color: #666; margin: 0 0 12px; }
    .stats { display: flex; gap: 16px; flex-wrap: wrap; }
    .stat { background: #f8f9fa; border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px 14px; min-width: 120px; }
    .stat-label { font-size: 12px; color: #666; }
    .stat-value { font-size: 20px; font-weight: 700; margin-top: 2px; }
    .stat-value.passed { color: #0a7; }
    .stat-value.failed { color: #c00; }
    .overall { font-size: 16px; font-weight: 700; margin-top: 12px; }
    .overall.passed { color: #0a7; }
    .overall.failed { color: #c00; }
    main { padding: 16px 24px 32px; max-width: 1200px; margin: 0 auto; }
    details.case { background: #fff; border: 1px solid #ddd; border-radius: 8px; margin-bottom: 10px; overflow: hidden; }
    details.case.failed { border-color: #f5c2c2; }
    details.case.passed { border-color: #b8e6d0; }
    summary { cursor: pointer; list-style: none; display: flex; align-items: center; gap: 10px; padding: 12px 14px; background: #fafafa; }
    summary::-webkit-details-marker { display: none; }
    .case-icon { font-weight: 700; width: 18px; }
    details.failed .case-icon { color: #c00; }
    details.passed .case-icon { color: #0a7; }
    .case-name { font-weight: 600; }
    .case-path { color: #666; font-size: 13px; flex: 1; }
    .case-meta { color: #888; font-size: 12px; }
    .case-status { font-size: 12px; font-weight: 700; padding: 2px 8px; border-radius: 999px; }
    .case-status.passed { background: #e6f7ef; color: #0a7; }
    .case-status.failed { background: #fdecec; color: #c00; }
    .case-body { padding: 0 14px 14px; }
    table { border-collapse: collapse; width: 100%; background: #fff; margin-top: 8px; font-size: 13px; }
    th, td { border: 1px solid #ddd; padding: 6px 10px; text-align: left; vertical-align: top; }
    th { background: #eee; }
    tr.pass td:nth-child(3) { color: #0a7; }
    tr.fail td:nth-child(3) { color: #c00; }
    pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 12px; }
    .step-logs { font-size: 12px; color: #666; max-width: 240px; }
    .log-count { display: inline-block; min-width: 18px; padding: 0 6px; border-radius: 999px; background: #fdecec; color: #c00; font-size: 11px; font-weight: 700; text-align: center; }
    ${visualAnalysisReportStyles}
    ${browserLogsReportStyles}
    ${screenshotGalleryReportStyles}
  </style>
</head>
<body>
  <header>
    <h1>${escapeHtml(input.suite)}</h1>
    ${input.description ? `<p class="desc">${escapeHtml(input.description)}</p>` : ''}
    <div class="stats">
      <div class="stat"><div class="stat-label">Total</div><div class="stat-value">${input.cases.length}</div></div>
      <div class="stat"><div class="stat-label">Passed</div><div class="stat-value passed">${passed}</div></div>
      <div class="stat"><div class="stat-label">Failed</div><div class="stat-value failed">${failed}</div></div>
    </div>
    <p class="overall ${overallStatus}">${overallStatus.toUpperCase()} · ${escapeHtml(input.startedAt)} → ${escapeHtml(input.finishedAt)}</p>
    <div class="screenshot-toolbar">
      ${renderScreenshotToggleButton()}
      <span id="screenshot-toggle-status" class="screenshot-toggle-status"></span>
    </div>
  </header>
  <main>${caseSections}</main>
  ${screenshotGalleryReportScript}
</body>
</html>`;

  const jsonPayload = {
    suite: input.suite,
    description: input.description,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    status: overallStatus,
    passed,
    failed,
    total: input.cases.length,
    cases: input.cases.map(({ path, priority, category, result }) => ({
      path,
      priority,
      category,
      name: result.name,
      status: result.status,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      reportDir: result.reportDir,
      message: result.steps.find(s => s.status === 'failed')?.message,
      steps: result.steps,
      browserLogs: result.browserLogs,
    })),
  };

  const htmlPath = join(outputDir, 'index.html');
  const jsonPath = join(outputDir, 'summary.json');
  writeFileSync(htmlPath, html);
  writeFileSync(jsonPath, JSON.stringify(jsonPayload, null, 2));

  return { htmlPath, jsonPath };
};
