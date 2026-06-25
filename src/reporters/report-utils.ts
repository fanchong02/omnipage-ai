import type { BrowserLogEntry, VisualAnalysis } from '../types.js';

export const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export const isAbnormalBrowserLog = (log: BrowserLogEntry) =>
  log.type === 'pageerror' ||
  log.level === 'error' ||
  (log.level === 'warning' && !log.message.includes('__name is not defined'));

export const dedupeBrowserLogs = (logs: BrowserLogEntry[]) => {
  const seen = new Set<string>();
  return logs.filter(log => {
    const key = `${log.type}:${log.level}:${log.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export const renderBrowserLogsHtml = (
  logs: BrowserLogEntry[] | undefined,
  options: { title?: string; emptyText?: string } = {}
) => {
  const abnormal = dedupeBrowserLogs((logs ?? []).filter(isAbnormalBrowserLog));
  if (abnormal.length === 0) {
    return options.emptyText ? `<p class="logs-empty">${escapeHtml(options.emptyText)}</p>` : '';
  }

  const title = options.title ?? '控制台 / 页面异常日志';
  const rows = abnormal
    .map(log => {
      const levelClass = log.type === 'pageerror' ? 'pageerror' : log.level;
      return `<tr class="log-${levelClass}">
        <td>${escapeHtml(log.timestamp)}</td>
        <td><span class="log-badge ${levelClass}">${escapeHtml(log.type === 'pageerror' ? 'pageerror' : log.level)}</span></td>
        <td><pre>${escapeHtml(log.message)}</pre></td>
      </tr>`;
    })
    .join('\n');

  return `<section class="browser-logs">
    <h3>${escapeHtml(title)} (${abnormal.length})</h3>
    <table class="logs-table">
      <thead>
        <tr><th>Time</th><th>Level</th><th>Message</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
};

export const browserLogsReportStyles = `
  .browser-logs { margin-top: 16px; }
  .browser-logs h3 { font-size: 14px; margin: 0 0 8px; color: #444; }
  .logs-table { border-collapse: collapse; width: 100%; background: #fff; font-size: 12px; }
  .logs-table th, .logs-table td { border: 1px solid #ddd; padding: 6px 10px; text-align: left; vertical-align: top; }
  .logs-table th { background: #f3f4f6; }
  .logs-table pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 12px; }
  .log-badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; text-transform: uppercase; }
  .log-badge.error, .log-badge.pageerror { background: #fdecec; color: #c00; }
  .log-badge.warning { background: #fff4e5; color: #b45309; }
  tr.log-error td, tr.log-pageerror td { background: #fffafa; }
  tr.log-warning td { background: #fffdf8; }
  .logs-empty { color: #888; font-size: 13px; margin: 8px 0 0; }
`;

const severityClass = (severity: VisualAnalysis['severity']) => {
  if (severity === 'high') return 'visual-high';
  if (severity === 'medium') return 'visual-medium';
  if (severity === 'low') return 'visual-low';
  return 'visual-none';
};

export const renderVisualAnalysisHtml = (
  analysis: VisualAnalysis | undefined,
  options: { title?: string; screenshotHref?: string } = {}
) => {
  if (!analysis) return '';

  const title = options.title ?? 'AI 视觉分析';
  const screenshot = options.screenshotHref
    ? `<div class="visual-screenshot">
        <span class="screenshot-compact"><p><a href="${escapeHtml(options.screenshotHref)}" target="_blank">查看截图</a></p></span>
        <span class="screenshot-expanded hidden">
          <a class="screenshot-open" href="${escapeHtml(options.screenshotHref)}" target="_blank" rel="noopener noreferrer" title="新窗口打开">
            <img data-src="${escapeHtml(options.screenshotHref)}" alt="视觉审查截图" />
          </a>
        </span>
      </div>`
    : '';
  const statusLabel = analysis.skipped
    ? '已跳过'
    : analysis.hasVisualIssue
      ? '存在视觉问题'
      : '视觉正常';
  const issues =
    analysis.issues.length > 0
      ? `<ul class="visual-issues">${analysis.issues
          .map(
            issue =>
              `<li><strong>${escapeHtml(issue.title)}</strong> <span class="visual-cat">${escapeHtml(issue.category)}</span><br/>${escapeHtml(issue.description)}</li>`
          )
          .join('')}</ul>`
      : '<p class="visual-ok">未发现明显视觉问题</p>';

  return `<section class="visual-analysis ${severityClass(analysis.severity)}">
    <h3>${escapeHtml(title)} — ${escapeHtml(statusLabel)}</h3>
    ${screenshot}
    <p class="visual-summary">${escapeHtml(analysis.summary)}</p>
    ${issues}
  </section>`;
};

export const renderScreenshotContent = (href: string, alt = 'screenshot') => {
  if (!href) return '-';
  const safeHref = escapeHtml(href);
  const safeAlt = escapeHtml(alt);
  return `<span class="screenshot-compact"><a href="${safeHref}">screenshot</a></span>
    <span class="screenshot-expanded hidden">
      <a class="screenshot-open" href="${safeHref}" target="_blank" rel="noopener noreferrer" title="新窗口打开">
        <img data-src="${safeHref}" alt="${safeAlt}" />
      </a>
    </span>`;
};

export const renderScreenshotCell = (href: string, alt = 'screenshot') => {
  if (!href) return '<td>-</td>';
  return `<td class="screenshot-cell" data-screenshot-href="${escapeHtml(href)}">${renderScreenshotContent(href, alt)}</td>`;
};

export const renderScreenshotToggleButton = () =>
  `<button type="button" id="toggle-screenshots" class="screenshot-toggle" aria-pressed="false">
    <span class="screenshot-toggle-label">展开全部截图</span>
  </button>`;

export const screenshotGalleryReportStyles = `
  .screenshot-toolbar { margin-top: 12px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .screenshot-toggle {
    appearance: none;
    border: 1px solid #cbd5e1;
    background: #fff;
    color: #1e293b;
    border-radius: 8px;
    padding: 8px 14px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s, opacity 0.15s;
  }
  .screenshot-toggle:hover:not(:disabled) { background: #f8fafc; border-color: #94a3b8; }
  .screenshot-toggle:disabled { opacity: 0.7; cursor: wait; }
  .screenshot-toggle[aria-pressed="true"] { background: #eff6ff; border-color: #60a5fa; color: #1d4ed8; }
  .screenshot-toggle-status { font-size: 13px; color: #64748b; }
  .screenshot-toggle-status.loading { color: #2563eb; }
  .screenshot-toggle-status.done { color: #0a7; }
  .screenshot-toggle-status.error { color: #c00; }
  .screenshot-cell { min-width: 120px; }
  .screenshot-compact.hidden,
  .screenshot-expanded.hidden { display: none; }
  .screenshot-expanded img {
    display: block;
    max-width: 280px;
    max-height: 200px;
    width: auto;
    height: auto;
    border: 1px solid #e2e8f0;
    border-radius: 6px;
    background: #f8fafc;
    cursor: zoom-in;
    transition: box-shadow 0.15s;
  }
  .screenshot-expanded img:hover { box-shadow: 0 4px 12px rgba(15, 23, 42, 0.12); }
  .screenshot-open { display: inline-block; line-height: 0; }
  body.screenshots-expanded .screenshot-compact { display: none; }
  body.screenshots-expanded .screenshot-expanded { display: block; }
  .visual-analysis .screenshot-compact.hidden + .screenshot-expanded,
  .visual-analysis .screenshot-expanded:not(.hidden) { margin-top: 8px; }
  .visual-analysis .screenshot-expanded img { max-width: 360px; max-height: 260px; }
`;

export const screenshotGalleryReportScript = `<script>
(function () {
  var btn = document.getElementById('toggle-screenshots');
  var status = document.getElementById('screenshot-toggle-status');
  if (!btn) return;

  var expanded = false;
  var loading = false;

  function getImages() {
    return Array.prototype.slice.call(document.querySelectorAll('.screenshot-expanded img'));
  }

  function setStatus(text, className) {
    if (!status) return;
    status.textContent = text || '';
    status.className = 'screenshot-toggle-status' + (className ? ' ' + className : '');
  }

  function setLabel(text) {
    var label = btn.querySelector('.screenshot-toggle-label');
    if (label) label.textContent = text;
  }

  function assignImageSources(images) {
    images.forEach(function (img) {
      var dataSrc = img.getAttribute('data-src');
      if (dataSrc && !img.getAttribute('src')) img.setAttribute('src', dataSrc);
    });
  }

  function preloadImages(images) {
    if (images.length === 0) return Promise.resolve({ loaded: 0, failed: 0 });
    assignImageSources(images);
    var loaded = 0;
    var failed = 0;
    return new Promise(function (resolve) {
      var pending = images.length;
      function done() {
        pending -= 1;
        if (pending === 0) resolve({ loaded: loaded, failed: failed });
      }
      images.forEach(function (img) {
        if (img.complete && img.naturalWidth > 0) {
          loaded += 1;
          done();
          return;
        }
        img.addEventListener('load', function () { loaded += 1; done(); }, { once: true });
        img.addEventListener('error', function () { failed += 1; done(); }, { once: true });
      });
    });
  }

  function collapse() {
    expanded = false;
    document.body.classList.remove('screenshots-expanded');
    btn.setAttribute('aria-pressed', 'false');
    setLabel('展开全部截图');
    setStatus('');
    document.querySelectorAll('.screenshot-expanded').forEach(function (el) {
      el.classList.add('hidden');
    });
  }

  function expand() {
    if (loading) return;
    loading = true;
    btn.disabled = true;
    btn.setAttribute('aria-pressed', 'true');
    setLabel('载入中…');

    document.querySelectorAll('.screenshot-expanded').forEach(function (el) {
      el.classList.remove('hidden');
    });
    document.body.classList.add('screenshots-expanded');

    var images = getImages();
    setStatus('正在载入 ' + images.length + ' 张截图…', 'loading');

    preloadImages(images).then(function (result) {
      loading = false;
      btn.disabled = false;
      expanded = true;
      setLabel('收起截图');
      if (result.failed > 0) {
        setStatus('已载入 ' + result.loaded + ' 张，' + result.failed + ' 张失败', 'error');
      } else {
        setStatus('已载入 ' + result.loaded + ' 张截图', 'done');
      }
    });
  }

  btn.addEventListener('click', function () {
    if (expanded) collapse();
    else expand();
  });
})();
</script>`;

export const visualAnalysisReportStyles = `
  .visual-analysis { margin-top: 16px; padding: 14px 16px; border-radius: 10px; border: 1px solid #e5e7eb; background: #fff; }
  .visual-analysis h3 { margin: 0 0 8px; font-size: 15px; }
  .visual-summary { margin: 0 0 10px; color: #374151; }
  .visual-issues { margin: 0; padding-left: 18px; }
  .visual-issues li { margin-bottom: 8px; }
  .visual-cat { display: inline-block; margin-left: 6px; padding: 1px 6px; border-radius: 999px; background: #f3f4f6; color: #6b7280; font-size: 11px; }
  .visual-ok { margin: 0; color: #0a7; }
  .visual-analysis.visual-high { border-color: #fecaca; background: #fff7f7; }
  .visual-analysis.visual-medium { border-color: #fed7aa; background: #fffaf5; }
  .visual-analysis.visual-low { border-color: #fde68a; background: #fffdf5; }
  .visual-analysis.visual-none { border-color: #bbf7d0; background: #f7fff9; }
  .step-visual { font-size: 12px; color: #555; max-width: 280px; }
  .step-visual.bad { color: #c00; }
`;
