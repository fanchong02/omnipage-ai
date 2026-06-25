import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { dismissKnownOverlays } from './overlay.js';
import { fillField, fillInputLocator, resolveSmartFillValue } from '../auth/form-fields.js';
import { capturePageScreenshot } from '../runner/progress-overlay.js';
import { getRootDir } from '../config.js';
import { captureAccessibilitySnapshot } from './snapshot.js';
import { getLlmConfig, getLlmConfigHint, isLlmConfigured } from './llm-client.js';
import { ensureLoggedIn } from '../auth/auto-login.js';
import { isLikelyLoginForm } from '../auth/login-form.js';
import {
  analyzePageInteractives,
  formatInteractivesDetail,
  formatInteractivesSummary,
  type InteractivesAnalysis,
} from './interactive-analyzer.js';
import {
  fingerprintExplorePlan,
  formatExplorePlanLabel,
  isDangerousExplorePlan,
  isDuplicateExplorePlan,
  planNextExploreAction,
  type ExploreHistoryEntry,
  type ExplorePlan,
} from './explore-planner.js';
import { enrichActionResult } from './explore-outcome.js';
import { executeFilterTest } from './filter-explore.js';
import { writeExploreHtmlReport } from '../reporters/explore-html-report.js';
import {
  headerBackSkipReason,
  isHeaderBackExplorePlan,
  shouldSkipHeaderBackTest,
} from './explore-navigation.js';

export type ExploreOptions = {
  maxActions?: number;
  fillInputs?: boolean;
  scroll?: boolean;
  safeMode?: boolean;
  navigateBack?: boolean;
  aiMode?: boolean;
  goal?: string;
  reportDir?: string;
  envName?: string;
  account?: string;
  authDisabled?: boolean;
  onAction?: (index: number, total: number, label: string) => void;
  onThink?: (index: number, plan: ExplorePlan) => void;
};

export type DiscoveredElement = {
  id: string;
  role: string;
  name: string;
  tag: string;
  inputType?: string;
  href?: string;
  disabled: boolean;
  headerBack?: boolean;
};

export type ExploreActionResult = {
  element?: DiscoveredElement;
  plan?: ExplorePlan;
  interactives?: InteractivesAnalysis;
  action: 'click' | 'fill' | 'toggle' | 'scroll' | 'skip' | 'done' | 'filterTest';
  success: boolean;
  reason?: string;
  urlBefore?: string;
  urlAfter?: string;
  screenshot?: string;
  screenshotAfter?: string;
  outcome?: string;
  feedback?: string[];
  thinking?: string;
};

export type ExploreReport = {
  startUrl: string;
  endUrl: string;
  discovered: number;
  attempted: number;
  succeeded: number;
  skipped: number;
  aiMode: boolean;
  actions: ExploreActionResult[];
};

const DEFAULT_OPTIONS: Required<
  Pick<ExploreOptions, 'maxActions' | 'fillInputs' | 'scroll' | 'safeMode' | 'navigateBack' | 'aiMode'>
> = {
  maxActions: 30,
  fillInputs: true,
  scroll: true,
  safeMode: true,
  navigateBack: true,
  aiMode: true,
};

const DANGEROUS_PATTERNS = [
  /pay\b/i,
  /purchase/i,
  /buy now/i,
  /checkout/i,
  /subscribe/i,
  /confirm order/i,
  /delete/i,
  /remove account/i,
  /logout/i,
  /log out/i,
  /sign out/i,
  /unsubscribe/i,
  /submit payment/i,
  /place order/i,
];

const SKIP_PATTERNS = [
  /^$/,
  /^el-\d+$/,
  /developer/i,
];

const NAVIGATION_SKIP_PATTERNS = [/^\s*back\s*$/i, /go back/i, /返回/i, /^←/, /chevron/i];

const shouldSkip = (el: DiscoveredElement, safeMode: boolean) => {
  if (el.disabled) return 'disabled';
  if (el.headerBack) return headerBackSkipReason;
  if (SKIP_PATTERNS.some(p => p.test(el.name))) return 'ignored label';
  if (safeMode && shouldSkipHeaderBackTest(el.name)) return headerBackSkipReason;
  if (safeMode && NAVIGATION_SKIP_PATTERNS.some(p => p.test(el.name))) return 'navigation control';
  if (el.inputType === 'file') return 'file input';
  if (el.inputType === 'hidden') return 'hidden input';
  if (el.tag === 'a' && el.href?.startsWith('mailto:')) return 'mailto link';
  return null;
};

const SAMPLE_VALUES: Record<string, string> = {
  email: 'qa-auto@example.com',
  tel: '13800138000',
  url: 'https://example.com',
  number: '1',
  search: 'test',
  text: 'QA Auto',
  password: 'WrongPass123!',
};

const isDangerous = (name: string, safeMode: boolean) => {
  if (!safeMode) return false;
  return DANGEROUS_PATTERNS.some(p => p.test(name));
};

const TAG_INTERACTIVE_SCRIPT = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'tag-interactive-elements.browser.js'),
  'utf8'
);

export const tagInteractiveElements = async (page: Page): Promise<DiscoveredElement[]> =>
  page.evaluate(TAG_INTERACTIVE_SCRIPT);

export const clearExploreTags = async (page: Page) => {
  await page
    .evaluate(() => {
      document.querySelectorAll('[data-qa-explore-id]').forEach(node => {
        node.removeAttribute('data-qa-explore-id');
      });
    })
    .catch(() => undefined);
};

const isLoginFieldElement = (el: DiscoveredElement) =>
  el.inputType === 'password' ||
  /password|密码/i.test(el.name) ||
  el.inputType === 'email' ||
  /email|账号|用户名|account|username|邮箱|login|手机|phone|mobile/i.test(el.name);

const isLoginFieldPlan = (name: string) =>
  /email|password|账号|用户名|密码|account|username|邮箱|login|手机|phone|mobile/i.test(name);

const skipLoginFormFill = async (page: Page, reason: string): Promise<ExploreActionResult | null> => {
  if (!(await isLikelyLoginForm(page))) return null;
  return { action: 'skip', success: true, reason };
};

const resolveFillValue = (el: DiscoveredElement): string | null => {
  const type = el.inputType ?? 'text';
  if (type === 'checkbox' || type === 'radio' || type === 'submit' || type === 'button') {
    return null;
  }
  if (type === 'email' || el.name.toLowerCase().includes('email')) return SAMPLE_VALUES.email;
  if (type === 'tel' || /phone|mobile/i.test(el.name)) return SAMPLE_VALUES.tel;
  if (type === 'url') return SAMPLE_VALUES.url;
  if (type === 'number') return SAMPLE_VALUES.number;
  if (type === 'search') return SAMPLE_VALUES.search;
  if (type === 'password' || /password/i.test(el.name)) return SAMPLE_VALUES.password;
  return resolveSmartFillValue(el.name, 'auto');
};

const resolveElementId = async (page: Page, target: DiscoveredElement): Promise<string | null> => {
  const elements = await tagInteractiveElements(page);
  const match = elements.find(el => el.tag === target.tag && el.name === target.name);
  return match?.id ?? null;
};

const restorePage = async (
  page: Page,
  startUrl: string,
  auth?: Pick<ExploreOptions, 'envName' | 'account' | 'authDisabled'>
) => {
  if (page.url() === startUrl) return;
  await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(async () => {
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10_000 }).catch(() => undefined);
  });
  await page.waitForTimeout(500);
  await dismissKnownOverlays(page);
  if (auth?.envName) {
    await ensureLoggedIn(page, {
      envName: auth.envName,
      account: auth.account,
      intendedPath: startUrl,
      returnTo: startUrl,
      disabled: auth.authDisabled,
    });
  }
};

const ensureExploreAuth = async (
  page: Page,
  startUrl: string,
  options: Pick<ExploreOptions, 'envName' | 'account' | 'authDisabled'>
) => {
  if (!options.envName || options.authDisabled) return;
  await ensureLoggedIn(page, {
    envName: options.envName,
    account: options.account,
    intendedPath: startUrl,
    returnTo: startUrl,
    disabled: options.authDisabled,
  });
};

const interactWithElement = async (
  page: Page,
  el: DiscoveredElement,
  options: typeof DEFAULT_OPTIONS & Pick<ExploreOptions, 'envName' | 'account' | 'authDisabled'>,
  startUrl: string
): Promise<ExploreActionResult> => {
  const skipReason = shouldSkip(el, options.safeMode);
  if (skipReason) {
    return { element: el, action: 'skip', success: true, reason: skipReason };
  }
  if (isDangerous(el.name, options.safeMode)) {
    return { element: el, action: 'skip', success: true, reason: 'safe mode blocked' };
  }

  if (!page.url().includes(new URL(startUrl).pathname) && page.url() !== 'about:blank') {
    await restorePage(page, startUrl, options);
  } else if (page.url() === 'about:blank' || !page.url().startsWith('http')) {
    await restorePage(page, startUrl, options);
  }

  const elementId = await resolveElementId(page, el);
  if (!elementId) {
    return { element: el, action: 'skip', success: true, reason: 'element not on page' };
  }

  const locator = page.locator(`[data-qa-explore-id="${elementId}"]`).first();

  try {
    await locator.scrollIntoViewIfNeeded({ timeout: 5000 });
    await dismissKnownOverlays(page);

    const isFillable =
      options.fillInputs &&
      (el.tag === 'input' || el.tag === 'textarea' || el.role === 'textbox');
    const fillValue = isFillable ? resolveFillValue(el) : null;

    if (fillValue !== null) {
      if (isLoginFieldElement(el)) {
        const skipped = await skipLoginFormFill(page, '登录表单字段，交由自动登录处理');
        if (skipped) {
          return { ...skipped, element: el };
        }
      }

      const selector =
        el.inputType === 'email' || /email/i.test(el.name)
          ? 'Email'
          : el.inputType === 'password' || /password/i.test(el.name)
            ? 'Password'
            : el.name;
      const shouldSubmit = /search|ask|prompt|message|email|name|password|comment|feedback|reason/i.test(
        `${selector} ${el.name} ${el.inputType ?? ''}`
      );
      try {
        await fillField(page, selector, fillValue, { submit: shouldSubmit });
      } catch {
        await fillInputLocator(locator, fillValue);
      }
      return {
        element: el,
        action: 'fill',
        success: true,
        urlAfter: page.url(),
      };
    }

    if (
      el.inputType === 'checkbox' ||
      el.inputType === 'radio' ||
      el.role === 'checkbox' ||
      el.role === 'radio' ||
      el.role === 'switch'
    ) {
      await locator.click({ timeout: 5000 });
      return {
        element: el,
        action: 'toggle',
        success: true,
        urlAfter: page.url(),
      };
    }

    const urlBeforeClick = page.url();
    await locator.click({ timeout: 5000 });
    await page.waitForTimeout(600);
    await dismissKnownOverlays(page);

    const urlAfter = page.url();
    if (options.navigateBack && urlAfter !== urlBeforeClick) {
      await restorePage(page, startUrl, options);
    }

    return {
      element: el,
      action: 'click',
      success: true,
      urlAfter,
    };
  } catch (err) {
    await restorePage(page, startUrl, options).catch(() => undefined);
    return {
      element: el,
      action: el.tag === 'input' || el.tag === 'textarea' ? 'fill' : 'click',
      success: false,
      reason: err instanceof Error ? err.message : String(err),
      urlAfter: page.url(),
    };
  }
};

const executeExplorePlan = async (
  page: Page,
  plan: ExplorePlan,
  startUrl: string,
  options: typeof DEFAULT_OPTIONS & Pick<ExploreOptions, 'envName' | 'account' | 'authDisabled'>
): Promise<ExploreActionResult> => {
  if (plan.type === 'skip') {
    return {
      plan,
      action: 'skip',
      success: true,
      reason: plan.reason,
      thinking: plan.reason,
      urlAfter: page.url(),
    };
  }

  if (plan.type === 'done') {
    return {
      plan,
      action: 'done',
      success: true,
      reason: plan.summary,
      thinking: plan.reasoning ?? plan.summary,
      urlAfter: page.url(),
    };
  }

  if (isDangerousExplorePlan(plan, options.safeMode)) {
    return {
      plan,
      action: 'skip',
      success: true,
      reason: 'safe mode blocked',
      thinking: plan.reasoning,
      urlAfter: page.url(),
    };
  }

  try {
    await dismissKnownOverlays(page);

    if (plan.type === 'scroll') {
      if (plan.direction === 'bottom') {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      } else {
        await page.evaluate(() => window.scrollTo(0, 0));
      }
      await page.waitForTimeout(400);
      return {
        plan,
        action: 'scroll',
        success: true,
        thinking: plan.reasoning,
        urlAfter: page.url(),
      };
    }

    if (plan.type === 'fill') {
      if (isLoginFieldPlan(plan.name)) {
        const skipped = await skipLoginFormFill(page, '登录表单字段，交由自动登录处理');
        if (skipped) {
          return {
            ...skipped,
            plan,
            thinking: plan.reasoning,
            urlAfter: page.url(),
          };
        }
      }

      await fillField(page, plan.name, plan.value, { submit: plan.submit });
      await page.waitForTimeout(500);
      return {
        plan,
        action: 'fill',
        success: true,
        thinking: plan.reasoning,
        urlAfter: page.url(),
      };
    }

    if (plan.type === 'filterTest') {
      const filterResult = await executeFilterTest(page, plan);
      return {
        plan,
        action: 'filterTest',
        success: filterResult.success,
        reason: filterResult.message,
        thinking: plan.reasoning,
        urlAfter: page.url(),
      };
    }

    if (plan.type === 'click') {
      if (isHeaderBackExplorePlan(plan)) {
        return {
          plan,
          action: 'skip',
          success: true,
          reason: headerBackSkipReason,
          thinking: plan.reasoning,
          urlAfter: page.url(),
        };
      }

      const urlBeforeClick = page.url();
      const locator = plan.role
        ? page.getByRole(plan.role as 'button' | 'link', { name: plan.name, exact: false })
        : page.getByText(plan.name, { exact: false });
      await locator.first().click({ timeout: 10_000 });
      await page.waitForTimeout(600);
      await dismissKnownOverlays(page);

      const urlAfter = page.url();
      if (options.navigateBack && urlAfter !== urlBeforeClick) {
        await restorePage(page, startUrl, options);
      }

      return {
        plan,
        action: 'click',
        success: true,
        thinking: plan.reasoning,
        urlAfter,
      };
    }

    return {
      plan,
      action: 'skip',
      success: true,
      reason: 'unknown plan type',
      urlAfter: page.url(),
    };
  } catch (err) {
    await restorePage(page, startUrl, options).catch(() => undefined);
    const action =
      plan.type === 'fill'
        ? 'fill'
        : plan.type === 'filterTest'
          ? 'filterTest'
          : plan.type === 'click'
            ? 'click'
            : 'skip';
    return {
      plan,
      action,
      success: false,
      reason: err instanceof Error ? err.message : String(err),
      thinking: 'reasoning' in plan ? plan.reasoning : undefined,
      urlAfter: page.url(),
    };
  }
};

const finalizeExploreAction = async (
  page: Page,
  result: ExploreActionResult,
  screenshotDir: string,
  stepNo: number,
  urlBefore: string
): Promise<ExploreActionResult> => {
  const afterPath = join(screenshotDir, `think-${String(stepNo).padStart(2, '0')}-after.png`);
  await capturePageScreenshot(page, { path: afterPath, fullPage: true }).catch(() => undefined);
  const enriched = await enrichActionResult(
    page,
    {
      action: result.action,
      plan: result.plan,
      element: result.element,
      success: result.success,
      reason: result.reason,
      urlBefore,
    },
    afterPath
  );
  return {
    ...result,
    urlBefore,
    urlAfter: enriched.urlAfter,
    outcome: enriched.outcome,
    feedback: enriched.feedback,
    screenshotAfter: afterPath,
  };
};

const writeExploreArtifacts = (report: ExploreReport, reportDir: string, pageUrl: string) => {
  writeFileSync(join(reportDir, 'explore-report.json'), JSON.stringify(report, null, 2));
  writeFileSync(
    join(reportDir, 'explore-thoughts.json'),
    JSON.stringify(
      report.actions.map((a, idx) => ({
        step: idx + 1,
        label: a.plan ? formatExplorePlanLabel(a.plan) : a.action,
        pageSummary: a.interactives?.pageSummary,
        interactives: a.interactives?.interactives,
        thinking:
          a.thinking ??
          (a.plan && 'reasoning' in a.plan ? a.plan.reasoning : undefined),
        success: a.success,
        reason: a.reason,
        outcome: a.outcome,
        urlBefore: a.urlBefore,
        urlAfter: a.urlAfter,
        feedback: a.feedback,
        screenshot: a.screenshot,
        screenshotAfter: a.screenshotAfter,
      })),
      null,
      2
    )
  );
  writeExploreHtmlReport(report, reportDir, {
    title: `探索报告 — ${pageUrl}`,
    url: pageUrl,
  });
};

const runAiPageExplore = async (
  page: Page,
  options: ExploreOptions = {}
): Promise<ExploreReport> => {
  const resolved = {
    ...DEFAULT_OPTIONS,
    aiMode: options.aiMode ?? Boolean(getLlmConfig()),
    ...options,
  };
  const startUrl = page.url();
  const actions: ExploreActionResult[] = [];
  const history: ExploreHistoryEntry[] = [];
  let discovered = 0;
  let consecutiveSkips = 0;

  if (resolved.scroll) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
  }

  await ensureExploreAuth(page, startUrl, resolved);

  if (!isLlmConfigured()) {
    console.warn(`\n⚠ ${getLlmConfigHint()}\n`);
  }

  for (let i = 0; i < resolved.maxActions; i += 1) {
    if (resolved.navigateBack && page.url() !== startUrl) {
      await restorePage(page, startUrl, resolved);
    }

    await ensureExploreAuth(page, startUrl, resolved);

    const elements = await tagInteractiveElements(page);
    discovered = Math.max(discovered, elements.length);

    const screenshotDir =
      options.reportDir ?? join(getRootDir(), 'reports', '.explore-cache');
    mkdirSync(screenshotDir, { recursive: true });
    const screenshotPath = join(
      screenshotDir,
      `think-${String(i + 1).padStart(2, '0')}-before.png`
    );

    await capturePageScreenshot(page, { path: screenshotPath, fullPage: true }).catch(() => undefined);

    const snapshot = await captureAccessibilitySnapshot(page);
    const interactives = await analyzePageInteractives(screenshotPath, {
      url: page.url(),
      domElements: elements,
    });

    console.log(`  [scan ${i + 1}] ${interactives.pageSummary}`);
    console.log(`  [scan ${i + 1}] 可交互: ${formatInteractivesSummary(interactives)}`);
    if (interactives.interactives.length > 0) {
      console.log(formatInteractivesDetail(interactives));
    }

    const plan = await planNextExploreAction({
      screenshotPath,
      url: page.url(),
      snapshot,
      elements,
      interactives,
      history,
      safeMode: resolved.safeMode,
      fillInputs: resolved.fillInputs,
      goal: options.goal,
    });

    options.onThink?.(i + 1, plan);
    console.log(`  [think ${i + 1}] ${formatExplorePlanLabel(plan)}`);

    if (plan.type === 'done') {
      const urlBefore = page.url();
      const doneResult = await finalizeExploreAction(
        page,
        {
          plan,
          interactives,
          action: 'done',
          success: true,
          reason: plan.summary,
          thinking: plan.reasoning ?? plan.summary,
          screenshot: screenshotPath,
        },
        screenshotDir,
        i + 1,
        urlBefore
      );
      actions.push(doneResult);
      break;
    }

    if (plan.type !== 'skip' && isDuplicateExplorePlan(plan, history)) {
      const skipPlan = {
        type: 'skip' as const,
        reason: '重复测试，已跳过',
        testIntent: plan.testIntent,
      };
      const urlBefore = page.url();
      const skipResult = await finalizeExploreAction(
        page,
        {
          plan: skipPlan,
          interactives,
          action: 'skip',
          success: true,
          reason: skipPlan.reason,
          thinking: skipPlan.reason,
          screenshot: screenshotPath,
        },
        screenshotDir,
        i + 1,
        urlBefore
      );
      actions.push(skipResult);
      history.push({
        plan: skipPlan,
        fingerprint: fingerprintExplorePlan(skipPlan),
        success: true,
        screenshot: screenshotPath,
      });
      consecutiveSkips += 1;
      if (consecutiveSkips >= 3) break;
      continue;
    }

    const label = formatExplorePlanLabel(plan);
    options.onAction?.(i + 1, resolved.maxActions, label);

    const urlBefore = page.url();
    const result = await executeExplorePlan(page, plan, startUrl, resolved);
    result.screenshot = screenshotPath;
    result.interactives = interactives;
    const finalized = await finalizeExploreAction(page, result, screenshotDir, i + 1, urlBefore);
    actions.push(finalized);
    if (finalized.outcome) {
      console.log(`  [result ${i + 1}] ${finalized.outcome}`);
    }

    history.push({
      plan,
      fingerprint: fingerprintExplorePlan(plan),
      success: finalized.success,
      error: finalized.reason,
      screenshot: screenshotPath,
    });

    if (plan.type === 'skip') {
      consecutiveSkips += 1;
      if (consecutiveSkips >= 3) break;
      continue;
    }
    consecutiveSkips = 0;
  }

  await clearExploreTags(page);

  const attempted = actions.filter(a => !['skip', 'done'].includes(a.action)).length;
  const succeeded = actions.filter(a => !['skip', 'done'].includes(a.action) && a.success).length;
  const skipped = actions.filter(a => a.action === 'skip').length;

  const report: ExploreReport = {
    startUrl,
    endUrl: page.url(),
    discovered,
    attempted,
    succeeded,
    skipped,
    aiMode: true,
    actions,
  };

  if (options.reportDir) {
    writeExploreArtifacts(report, options.reportDir, startUrl);
  }

  return report;
};

const runQueuePageExplore = async (
  page: Page,
  options: ExploreOptions = {}
): Promise<ExploreReport> => {
  const resolved = { ...DEFAULT_OPTIONS, ...options };
  const startUrl = page.url();
  const actions: ExploreActionResult[] = [];

  if (resolved.scroll) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
  }

  let discovered = await tagInteractiveElements(page);

  await ensureExploreAuth(page, startUrl, resolved);

  if (resolved.scroll && discovered.length > 0) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(500);
    const afterScroll = await tagInteractiveElements(page);
    const known = new Set(discovered.map(el => `${el.tag}:${el.name}`));
    for (const el of afterScroll) {
      if (!known.has(`${el.tag}:${el.name}`)) {
        discovered.push(el);
        known.add(`${el.tag}:${el.name}`);
      }
    }
  }

  const queue = discovered.slice(0, resolved.maxActions);
  const screenshotDir = options.reportDir ?? join(getRootDir(), 'reports', '.explore-cache');
  if (options.reportDir) mkdirSync(screenshotDir, { recursive: true });

  for (let i = 0; i < queue.length; i += 1) {
    const el = queue[i];
    const label = `${el.role}「${el.name}」`;
    options.onAction?.(i + 1, queue.length, label);

    const urlBefore = page.url();
    const beforePath = options.reportDir
      ? join(screenshotDir, `explore-${String(i + 1).padStart(2, '0')}-before.png`)
      : undefined;
    if (beforePath) {
      await capturePageScreenshot(page, { path: beforePath }).catch(() => undefined);
    }

    const result = await interactWithElement(page, el, resolved, startUrl);
    if (beforePath) result.screenshot = beforePath;

    const finalized = await finalizeExploreAction(
      page,
      result,
      screenshotDir,
      i + 1,
      urlBefore
    );
    actions.push(finalized);
  }

  await clearExploreTags(page);

  const attempted = actions.filter(a => a.action !== 'skip').length;
  const succeeded = actions.filter(a => a.action !== 'skip' && a.success).length;
  const skipped = actions.filter(a => a.action === 'skip').length;

  const report: ExploreReport = {
    startUrl,
    endUrl: page.url(),
    discovered: discovered.length,
    attempted,
    succeeded,
    skipped,
    aiMode: false,
    actions,
  };

  if (options.reportDir) {
    writeExploreArtifacts(report, options.reportDir, startUrl);
  }

  return report;
};

export const runPageExplore = async (
  page: Page,
  options: ExploreOptions = {}
): Promise<ExploreReport> => {
  const useAi = options.aiMode ?? DEFAULT_OPTIONS.aiMode;
  if (useAi) {
    return runAiPageExplore(page, options);
  }
  return runQueuePageExplore(page, options);
};

export const formatExploreSummary = (report: ExploreReport) => {
  const mode = report.aiMode ? 'AI 逐步思考' : '队列扫描';
  return `[${mode}] 发现 ${report.discovered} 个可交互元素，尝试 ${report.attempted} 次，成功 ${report.succeeded} 次，跳过 ${report.skipped} 次`;
};
