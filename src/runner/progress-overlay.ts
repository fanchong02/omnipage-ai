import type { BrowserContext, Page } from '@playwright/test';

export type ProgressState = {
  scenario: string;
  current: number;
  total: number;
  stepLabel: string;
  status: 'running' | 'passed' | 'failed' | 'done';
  message?: string;
};

/** Plain JS string — avoid tsx serializing functions with __name into the page */
const OVERLAY_INIT_SCRIPT = `
(() => {
  const ROOT_ID = '__qa_progress_root__';

  const ensureStyles = () => {
    if (document.getElementById('__qa_progress_styles__')) return;
    const style = document.createElement('style');
    style.id = '__qa_progress_styles__';
    style.textContent = \`
      #\${ROOT_ID} {
        all: initial;
        position: fixed;
        top: 12px;
        right: 12px;
        z-index: 2147483647;
        width: min(320px, calc(100vw - 24px));
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #f8fafc;
        background: rgba(15, 23, 42, 0.92);
        border: 1px solid rgba(148, 163, 184, 0.35);
        border-radius: 12px;
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
        padding: 12px 14px;
        backdrop-filter: blur(8px);
        pointer-events: none;
      }
      #\${ROOT_ID} .qa-title { font-size: 12px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: #94a3b8; margin-bottom: 6px; }
      #\${ROOT_ID} .qa-scenario { font-size: 14px; font-weight: 600; margin-bottom: 8px; line-height: 1.3; }
      #\${ROOT_ID} .qa-step { font-size: 13px; line-height: 1.4; margin-bottom: 10px; color: #e2e8f0; }
      #\${ROOT_ID} .qa-bar { height: 6px; border-radius: 999px; background: rgba(148, 163, 184, 0.25); overflow: hidden; margin-bottom: 8px; }
      #\${ROOT_ID} .qa-bar > span { display: block; height: 100%; width: 0%; border-radius: inherit; background: linear-gradient(90deg, #38bdf8, #22c55e); transition: width 0.25s ease; }
      #\${ROOT_ID} .qa-meta { display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: #94a3b8; }
      #\${ROOT_ID} .qa-status { font-weight: 700; }
      #\${ROOT_ID}[data-status="running"] .qa-status { color: #38bdf8; }
      #\${ROOT_ID}[data-status="passed"] .qa-status, #\${ROOT_ID}[data-status="done"] .qa-status { color: #22c55e; }
      #\${ROOT_ID}[data-status="failed"] .qa-status { color: #ef4444; }
      #\${ROOT_ID} .qa-message { margin-top: 8px; font-size: 12px; line-height: 1.35; color: #fca5a5; }
    \`;
    document.documentElement.appendChild(style);
  };

  const render = (state) => {
    ensureStyles();
    let root = document.getElementById(ROOT_ID);
    if (!root) {
      root = document.createElement('div');
      root.id = ROOT_ID;
      document.documentElement.appendChild(root);
    }
    const percent = state.total > 0 ? Math.round((state.current / state.total) * 100) : 0;
    const statusLabel =
      state.status === 'running' ? '执行中'
      : state.status === 'passed' ? '通过'
      : state.status === 'failed' ? '失败'
      : '完成';
    root.setAttribute('data-status', state.status);
    root.innerHTML =
      '<div class="qa-title">Omnipage AI</div>' +
      '<div class="qa-scenario">' + state.scenario + '</div>' +
      '<div class="qa-step">' + state.stepLabel + '</div>' +
      '<div class="qa-bar"><span style="width:' + percent + '%"></span></div>' +
      '<div class="qa-meta"><span>步骤 ' + state.current + '/' + state.total + '</span>' +
      '<span class="qa-status">' + statusLabel + '</span></div>' +
      (state.message ? '<div class="qa-message">' + state.message + '</div>' : '');
  };

  window.__qaUpdateProgress = render;
  if (window.__qaProgressState) render(window.__qaProgressState);
})();
`;

export const installProgressOverlay = async (context: BrowserContext) => {
  await context.addInitScript(OVERLAY_INIT_SCRIPT);
};

export const updateProgressOverlay = async (page: Page, state: ProgressState) => {
  await page
    .evaluate(
      s => {
        (window as Window & { __qaProgressState?: ProgressState }).__qaProgressState = s;
        (window as Window & { __qaUpdateProgress?: (state: ProgressState) => void }).__qaUpdateProgress?.(
          s
        );
      },
      state
    )
    .catch(() => undefined);
};

const PROGRESS_ROOT_ID = '__qa_progress_root__';

export const hideProgressOverlay = async (page: Page) => {
  await page
    .evaluate(id => {
      const root = document.getElementById(id);
      if (root) root.style.display = 'none';
    }, PROGRESS_ROOT_ID)
    .catch(() => undefined);
};

export const showProgressOverlay = async (page: Page) => {
  await page
    .evaluate(id => {
      const root = document.getElementById(id);
      if (root) root.style.display = '';
    }, PROGRESS_ROOT_ID)
    .catch(() => undefined);
};

export const capturePageScreenshot = async (
  page: Page,
  options: Parameters<Page['screenshot']>[0]
) => {
  await hideProgressOverlay(page);
  try {
    await page.screenshot(options);
  } finally {
    await showProgressOverlay(page);
  }
};

export const formatStepLabel = (step: Record<string, unknown>): string => {
  if ('goto' in step) return `打开页面 ${step.goto}`;
  if ('click' in step) return `点击「${step.click}」`;
  if ('fill' in step) {
    const fill = step.fill as { selector: string; value: string; submit?: boolean };
    const suffix = fill.submit ? ' 并提交' : '';
    return `填写「${fill.selector}」${suffix}`;
  }
  if ('upload' in step) return `上传文件「${step.upload.file}」`;
  if ('assertVisible' in step) return `断言可见「${step.assertVisible}」`;
  if ('assertUrl' in step) return `断言 URL 包含「${step.assertUrl}」`;
  if ('assertNoOverflow' in step) return `检查文案不溢出「${step.assertNoOverflow}」`;
  if ('assertVisual' in step) return 'AI 视觉断言';
  if ('wait' in step) return `等待 ${step.wait}ms`;
  if ('scroll' in step) return `滚动到${step.scroll === 'bottom' ? '底部' : '顶部'}`;
  if ('screenshot' in step) return `截图「${step.screenshot}」`;
  if ('explore' in step) return '自动探索页面交互';
  if ('login' in step) {
    const login = step.login;
    const account = typeof login === 'string' ? login : (login as { account?: string }).account;
    return `登录账号「${account ?? 'default'}」`;
  }
  if ('seedAuth' in step) return '注入登录态';
  if ('agent' in step) {
    const text = String(step.agent).trim().replace(/\s+/g, ' ');
    return `AI 任务：${text.slice(0, 48)}${text.length > 48 ? '…' : ''}`;
  }
  return JSON.stringify(step);
};

export const printStepProgress = (
  current: number,
  total: number,
  label: string,
  status: 'start' | 'pass' | 'fail'
) => {
  const prefix = `[${current}/${total}]`;
  if (status === 'start') console.log(`\n▶ ${prefix} ${label}`);
  else if (status === 'pass') console.log(`✓ ${prefix} ${label}`);
  else console.log(`✗ ${prefix} ${label}`);
};
