import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { ScenarioResult } from '../types.js';
import { writeExploreHtmlReport } from './explore-html-report.js';
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
import {
  exploreFlowReportStyles,
  exploreSubDirForStep,
  loadExploreReport,
  renderExploreFlowHtml,
} from './explore-flow-render.js';

const renderStepLogsPreview = (logs: ScenarioResult['steps'][number]['browserLogs']) => {
  const abnormal = dedupeBrowserLogs((logs ?? []).filter(isAbnormalBrowserLog));
  if (abnormal.length === 0) return '-';
  const preview = abnormal
    .slice(0, 2)
    .map(log => escapeHtml(log.message))
    .join('<br/>');
  const suffix = abnormal.length > 2 ? `<br/><em>+${abnormal.length - 2} more</em>` : '';
  return preview + suffix;
};

const formatStepLabel = (step: ScenarioResult['steps'][number]['step']) => {
  if ('goto' in step) return `打开 ${step.goto}`;
  if ('login' in step) return `登录 ${step.login}`;
  if ('click' in step) return `点击 ${step.click}`;
  if ('explore' in step) return '页面探索';
  return JSON.stringify(step);
};

const renderStepExploreDetail = (
  step: ScenarioResult['steps'][number],
  reportDir: string
) => {
  const exploreSubDir = step.exploreReportDir ?? exploreSubDirForStep(step.index);
  const exploreReport = loadExploreReport(reportDir, exploreSubDir);
  if (!exploreReport) {
    return step.message ? `<p class="step-summary">${escapeHtml(step.message)}</p>` : '-';
  }

  return renderExploreFlowHtml(exploreReport, reportDir, {
    compact: true,
    detailHref: `${exploreSubDir}/index.html`,
    exploreReportDir: exploreSubDir,
  });
};

export const writeHtmlReport = (result: ScenarioResult, outputPath?: string) => {
  const reportPath = outputPath ?? join(result.reportDir, 'index.html');
  const reportDir = join(reportPath, '..');

  const stepRows = result.steps
    .map(step => {
      const stepLabel = escapeHtml(formatStepLabel(step.step));
      const statusClass = step.status === 'passed' ? 'pass' : 'fail';
      const screenshot = step.screenshot
        ? renderScreenshotContent(
            relative(reportDir, step.screenshot).split('\\').join('/'),
            `Step ${step.index + 1} screenshot`
          )
        : '-';
      const visual = step.visualAnalysis
        ? `<div class="step-visual ${step.visualAnalysis.hasVisualIssue ? 'bad' : ''}">${escapeHtml(step.visualAnalysis.summary)}</div>`
        : '-';
      const exploreDetail = renderStepExploreDetail(step, reportDir);

      return `<tr class="${statusClass}">
        <td>${step.index + 1}</td>
        <td><strong>${stepLabel}</strong><pre class="step-json">${escapeHtml(JSON.stringify(step.step))}</pre></td>
        <td>${step.status}</td>
        <td class="explore-detail-cell">${exploreDetail}</td>
        <td class="step-logs">${renderStepLogsPreview(step.browserLogs)}</td>
        <td class="step-visual-cell">${visual}</td>
        <td>${step.durationMs}ms</td>
        <td class="screenshot-cell">${screenshot}</td>
      </tr>`;
    })
    .join('\n');

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>QA Report — ${escapeHtml(result.name)}</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 24px; background: #f8f9fa; }
    h1 { margin-bottom: 4px; }
    .status { font-size: 18px; font-weight: bold; }
    .status.passed { color: #0a7; }
    .status.failed { color: #c00; }
    table { border-collapse: collapse; width: 100%; background: #fff; margin-top: 16px; }
    th, td { border: 1px solid #ddd; padding: 8px 12px; text-align: left; vertical-align: top; }
    th { background: #eee; }
    tr.pass td:nth-child(3) { color: #0a7; }
    tr.fail td:nth-child(3) { color: #c00; }
    pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 12px; }
    pre.step-json { margin-top: 6px; color: #64748b; font-size: 11px; }
    .step-summary { margin: 0; font-size: 13px; color: #334155; }
    .step-logs { font-size: 12px; color: #666; max-width: 200px; }
    .step-logs em { color: #888; }
    ${visualAnalysisReportStyles}
    ${browserLogsReportStyles}
    ${screenshotGalleryReportStyles}
    ${exploreFlowReportStyles}
  </style>
</head>
<body>
  <h1>${escapeHtml(result.name)}</h1>
  <p class="status ${result.status}">${result.status.toUpperCase()}</p>
  <p>${escapeHtml(result.startedAt)} → ${escapeHtml(result.finishedAt)}</p>
  <div class="screenshot-toolbar">
    ${renderScreenshotToggleButton()}
    <span id="screenshot-toggle-status" class="screenshot-toggle-status"></span>
  </div>
  <table>
    <thead>
      <tr><th>#</th><th>Step</th><th>Status</th><th>探索流程（元素 / 操作 / 结果）</th><th>Console</th><th>Visual</th><th>Duration</th><th>Screenshot</th></tr>
    </thead>
    <tbody>${stepRows}</tbody>
  </table>
  ${renderVisualAnalysisHtml(result.visualReview?.analysis, {
    title: '场景 AI 视觉审查',
    screenshotHref: result.visualReview?.screenshot
      ? relative(reportDir, result.visualReview.screenshot).split('\\').join('/')
      : undefined,
  })}
  ${renderBrowserLogsHtml(result.browserLogs, { title: '全部异常控制台日志' })}
  ${screenshotGalleryReportScript}
</body>
</html>`;

  mkdirSync(join(reportPath, '..'), { recursive: true });
  writeFileSync(reportPath, html);
  return reportPath;
};

/** 从已有 result.json + explore-report.json 重新生成 HTML（无需重跑测试） */
export const refreshHtmlReportFromDir = (reportDir: string) => {
  const resultPath = join(reportDir, 'result.json');
  const result = JSON.parse(readFileSync(resultPath, 'utf8')) as ScenarioResult;
  result.reportDir = reportDir;
  writeHtmlReport(result);

  for (const step of result.steps) {
    const exploreSubDir = step.exploreReportDir ?? exploreSubDirForStep(step.index);
    const exploreReport = loadExploreReport(reportDir, exploreSubDir);
    if (exploreReport) {
      writeExploreHtmlReport(exploreReport, join(reportDir, exploreSubDir), {
        title: `探索报告 — ${formatStepLabel(step.step)}`,
        url: exploreReport.startUrl,
        finishedAt: result.finishedAt,
      });
    }
  }
};
