import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { runAgentTask } from '../agent/executor.js';
import { dismissKnownOverlays } from '../agent/overlay.js';
import { formatExploreSummary, runPageExplore, type ExploreOptions } from '../agent/page-explorer.js';
import {
  analyzeScreenshot,
  formatVisualAnalysis,
  shouldFailOnVisualAnalysis,
} from '../agent/visual-analyzer.js';
import { getRootDir } from '../config.js';
import { performLogin } from '../auth/login.js';
import { fillField, uploadFile, waitForClickable } from '../auth/form-fields.js';
import { ensureLoggedIn, shouldSkipAutoLogin } from '../auth/auto-login.js';
import { resolveAccount, resolveLoginAccount } from '../credentials.js';
import { seedAuthStorage, type AuthSeedOptions } from '../mocks/auth-seed.js';
import {
  setupRouteMocks,
  type MockRoute,
} from '../mocks/route-interceptor.js';
import {
  createPlaywrightSession,
  getBrowserLogs,
  getPageErrors,
} from './playwright-session.js';
import {
  resolveAssertVisualOptions,
  resolveVisualReviewOptions,
  runScenarioVisualReview,
} from '../reporters/visual-review.js';
import {
  formatStepLabel,
  printStepProgress,
  updateProgressOverlay,
  capturePageScreenshot,
} from './progress-overlay.js';
import type {
  Scenario,
  ScenarioResult,
  ScenarioStep,
  StepResult,
  ExploreStepOptions,
  VisualAnalysis,
} from '../types.js';

const resolveLoginStep = (step: { login: string | { account?: string; path?: string } }) => {
  if (typeof step.login === 'string') {
    return { account: step.login };
  }
  return step.login;
};

const resolveSeedAuthOptions = (
  seedAuth: Record<string, unknown> | undefined,
  envName: string
): AuthSeedOptions => {
  if (!seedAuth) return {};
  if (typeof seedAuth.account === 'string') {
    const account = resolveAccount(seedAuth.account, envName);
    return {
      email: account.email,
      displayName: account.displayName,
      uid: account.uid,
      accessToken: account.accessToken,
      refreshToken: account.refreshToken,
      isAnonymous: false,
    };
  }
  if (seedAuth.isAnonymous === false) {
    return { ...(seedAuth as AuthSeedOptions), isAnonymous: false };
  }
  return seedAuth as AuthSeedOptions;
};

const resolveSelector = (selector: string) => {
  if (selector.startsWith('text=')) {
    return selector.slice(5);
  }
  return selector;
};

const IGNORED_PAGE_ERROR_PATTERNS = [
  '__name is not defined',
  'ResizeObserver',
  'Non-Error',
  'fireauth is not defined',
];

const isIgnoredPageError = (message: string) =>
  IGNORED_PAGE_ERROR_PATTERNS.some(pattern => message.includes(pattern));

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const assertUrlContains = async (page: Page, fragment: string) => {
  const pattern = new RegExp(escapeRegExp(resolveSelector(fragment)), 'i');
  if (pattern.test(page.url())) return;
  await page.waitForURL(pattern, { timeout: 15_000, waitUntil: 'domcontentloaded' });
};

const resolveExploreOptions = (
  explore: boolean | ExploreStepOptions | undefined
): ExploreOptions | null => {
  if (!explore) return null;
  if (explore === true) return {};
  return explore;
};

const runExploreForPage = async (
  page: Page,
  exploreOptions: ExploreOptions,
  reportDir: string,
  labelPrefix: string,
  auth: { envName: string; scenario: Scenario },
  onAction?: (current: number, total: number, label: string) => void
) => {
  const exploreDir = join(reportDir, labelPrefix);
  mkdirSync(exploreDir, { recursive: true });
  const report = await runPageExplore(page, {
    ...exploreOptions,
    envName: auth.envName,
    account: typeof auth.scenario.autoLogin === 'string' ? auth.scenario.autoLogin : undefined,
    authDisabled: shouldSkipAutoLogin({ scenario: auth.scenario }),
    reportDir: exploreDir,
    onAction,
  });
  return { summary: formatExploreSummary(report), exploreReportDir: labelPrefix };
};

const assertNoTextOverflow = async (page: Page, text: string) => {
  const locator = page.getByText(text, { exact: false }).first();
  await locator.waitFor({ state: 'visible', timeout: 10_000 });
  const overflow = await locator.evaluate(el => {
    const node = el as HTMLElement;
    return node.scrollWidth > node.clientWidth + 1;
  });
  if (overflow) {
    throw new Error(`Text overflow detected for "${text}"`);
  }
};

const executeStep = async (
  page: Page,
  step: ScenarioStep,
  reportDir: string,
  stepIndex: number,
  envName: string,
  scenario: Scenario
): Promise<StepResult> => {
  const started = Date.now();
  const screenshotPath = join(reportDir, `step-${String(stepIndex + 1).padStart(2, '0')}.png`);
  let exploreSummary: string | undefined;
  let exploreReportDir: string | undefined;
  let visualAnalysis: VisualAnalysis | undefined;

  try {
    if ('goto' in step) {
      await page.goto(step.goto, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(1000);

      await ensureLoggedIn(page, {
        envName,
        scenario,
        intendedPath: step.goto,
        returnTo: step.goto,
      });

      const nextStep = scenario.steps[stepIndex + 1];
      const skipExploreBeforeLogin = nextStep != null && 'login' in nextStep;

      const autoExplore = resolveExploreOptions(scenario.autoExplore);
      if (autoExplore && !skipExploreBeforeLogin) {
        const exploreResult = await runExploreForPage(
          page,
          autoExplore,
          reportDir,
          `explore-after-step-${String(stepIndex + 1).padStart(2, '0')}`,
          { envName, scenario },
          (current, total, label) => {
            console.log(`  [explore ${current}/${total}] ${label}`);
          }
        );
        exploreSummary = exploreResult.summary;
        exploreReportDir = exploreResult.exploreReportDir;
        console.log(`  ↳ ${exploreSummary}`);
      }
    } else if ('click' in step) {
      const text = resolveSelector(step.click);
      await dismissKnownOverlays(page);
      const locator = page
        .getByRole('button', { name: text, exact: false })
        .or(page.getByRole('link', { name: text, exact: false }))
        .or(page.getByText(text, { exact: false }))
        .first();
      await waitForClickable(locator);
      await locator.click({ timeout: 10_000 });
    } else if ('fill' in step) {
      await fillField(page, step.fill.selector, step.fill.value, { submit: step.fill.submit });
    } else if ('upload' in step) {
      await uploadFile(page, join(getRootDir(), step.upload.file), step.upload.selector);
    } else if ('assertVisible' in step) {
      const text = resolveSelector(step.assertVisible);
      const locator = page.getByText(text, { exact: false }).first();
      await locator.scrollIntoViewIfNeeded().catch(() => undefined);
      await locator.waitFor({
        state: 'visible',
        timeout: 15_000,
      });
    } else if ('assertUrl' in step) {
      await assertUrlContains(page, step.assertUrl);
    } else if ('assertNoOverflow' in step) {
      const text = resolveSelector(step.assertNoOverflow);
      await assertNoTextOverflow(page, text);
    } else if ('assertVisual' in step) {
      await capturePageScreenshot(page, { path: screenshotPath, fullPage: true });
      const visualOptions = resolveAssertVisualOptions(step.assertVisual);
      const stepLabel = formatStepLabel(step as Record<string, unknown>);
      visualAnalysis = await analyzeScreenshot(screenshotPath, {
        scenarioName: scenario.name,
        stepLabel,
        url: page.url(),
        category: scenario.category,
        customPrompt: visualOptions.prompt,
      });
      console.log(`  [visual] ${formatVisualAnalysis(visualAnalysis)}`);
      if (
        shouldFailOnVisualAnalysis(visualAnalysis, {
          strict: visualOptions.strict,
          category: scenario.category,
        })
      ) {
        throw new Error(`视觉断言失败: ${formatVisualAnalysis(visualAnalysis)}`);
      }
    } else if ('wait' in step) {
      await page.waitForTimeout(step.wait);
    } else if ('scroll' in step) {
      if (step.scroll === 'bottom') {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      } else {
        await page.evaluate(() => window.scrollTo(0, 0));
      }
    } else if ('screenshot' in step) {
      await capturePageScreenshot(page, { path: screenshotPath, fullPage: true });
    } else if ('explore' in step) {
      await ensureLoggedIn(page, { envName, scenario });
      const exploreOptions = resolveExploreOptions(step.explore);
      if (!exploreOptions) {
        throw new Error('explore step requires true or options object');
      }
      const exploreResult = await runExploreForPage(
        page,
        exploreOptions,
        reportDir,
        `explore-step-${String(stepIndex + 1).padStart(2, '0')}`,
        { envName, scenario },
        (current, total, label) => {
          console.log(`  [explore ${current}/${total}] ${label}`);
        }
      );
      exploreSummary = exploreResult.summary;
      exploreReportDir = exploreResult.exploreReportDir;
      console.log(`  ↳ ${exploreSummary}`);
    } else if ('agent' in step) {
      await ensureLoggedIn(page, { envName, scenario });
      await runAgentTask(page, step.agent.trim(), {
        envName,
        account: typeof scenario.autoLogin === 'string' ? scenario.autoLogin : undefined,
        authDisabled: shouldSkipAutoLogin({ scenario }),
        onStep: (_i, action) => {
          console.log(`  [agent] ${JSON.stringify(action)}`);
        },
      });
      await capturePageScreenshot(page, { path: screenshotPath, fullPage: true });
    } else if ('login' in step) {
      const { account: accountName, path } = resolveLoginStep(step);
      const account = resolveLoginAccount(accountName, envName);
      await performLogin(page, account, { loginUrl: path });
    } else if ('seedAuth' in step) {
      // seedAuth handled at context level; no-op at step level
    } else {
      throw new Error(`Unsupported step: ${JSON.stringify(step)}`);
    }

    const shouldTryAutoLogin =
      !('login' in step) &&
      !('seedAuth' in step) &&
      !('explore' in step) &&
      !('assertVisual' in step) &&
      !('upload' in step) &&
      !('goto' in step) &&
      ('click' in step || 'wait' in step || 'scroll' in step || 'agent' in step);
    if (shouldTryAutoLogin) {
      await ensureLoggedIn(page, { envName, scenario });
    }

    if (!('screenshot' in step) && !('agent' in step) && !('assertVisual' in step)) {
      await capturePageScreenshot(page, { path: screenshotPath }).catch(() => undefined);
    }

    return {
      index: stepIndex,
      step,
      status: 'passed',
      message: exploreSummary,
      exploreReportDir,
      screenshot: screenshotPath,
      visualAnalysis,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    await capturePageScreenshot(page, { path: screenshotPath, fullPage: true }).catch(
      () => undefined
    );
    return {
      index: stepIndex,
      step,
      status: 'failed',
      message: err instanceof Error ? err.message : String(err),
      screenshot: screenshotPath,
      visualAnalysis,
      durationMs: Date.now() - started,
    };
  }
};

export const runScenario = async (
  scenarioInput: Scenario,
  options: {
    headless?: boolean;
    reportRoot?: string;
    showProgress?: boolean;
    slowMo?: number;
    pauseOnFinishMs?: number;
    visualReview?: boolean;
  } = {}
): Promise<ScenarioResult> => {
  const scenario: Scenario = {
    ...scenarioInput,
    autoLogin:
      scenarioInput.autoLogin !== undefined
        ? scenarioInput.autoLogin
        : scenarioInput.steps.some(s => 'seedAuth' in s) ||
            scenarioInput.module?.startsWith('auth/login') ||
            scenarioInput.category === 'abnormal'
          ? false
          : 'e2e',
  };

  const startedAt = new Date().toISOString();
  const reportDir = join(
    options.reportRoot ?? join(getRootDir(), 'reports'),
    `${scenario.name}-${Date.now()}`
  );
  mkdirSync(reportDir, { recursive: true });

  const session = await createPlaywrightSession({
    envName: scenario.env,
    deviceName: scenario.viewport,
    headless: options.headless,
    slowMo: options.slowMo,
    showProgress: options.showProgress,
  });

  const mocks: MockRoute[] = [...(scenario.mocks ?? [])];

  await setupRouteMocks(session.context, mocks);

  const seedStep = scenario.steps.find(s => 'seedAuth' in s);
  if (seedStep && 'seedAuth' in seedStep) {
    await seedAuthStorage(
      session.context,
      resolveSeedAuthOptions(seedStep.seedAuth as Record<string, unknown>, scenario.env)
    );
  }

  const stepResults: StepResult[] = [];
  let failed = false;
  let browserLogs: ScenarioResult['browserLogs'] = [];
  const totalSteps = scenario.steps.length;
  const showProgress = options.showProgress ?? false;

  const syncProgress = async (
    current: number,
    step: ScenarioStep,
    status: 'running' | 'passed' | 'failed' | 'done',
    message?: string
  ) => {
    if (!showProgress) return;
    await updateProgressOverlay(session.page, {
      scenario: scenario.name,
      current,
      total: totalSteps,
      stepLabel: formatStepLabel(step as Record<string, unknown>),
      status,
      message,
    });
  };

  try {
    for (let i = 0; i < scenario.steps.length; i += 1) {
      const step = scenario.steps[i];
      const label = formatStepLabel(step as Record<string, unknown>);
      const logsBefore = getBrowserLogs(session.page).length;
      printStepProgress(i + 1, totalSteps, label, 'start');
      await syncProgress(i + 1, step, 'running');
      const result = await executeStep(session.page, step, reportDir, i, scenario.env, scenario);
      result.browserLogs = getBrowserLogs(session.page).slice(logsBefore);
      stepResults.push(result);
      if (result.status === 'failed') {
        failed = true;
        printStepProgress(i + 1, totalSteps, label, 'fail');
        await syncProgress(i + 1, step, 'failed', result.message);
        break;
      }
      printStepProgress(i + 1, totalSteps, label, 'pass');
      await syncProgress(i + 1, step, 'passed');
    }

    browserLogs = getBrowserLogs(session.page);
    const { pageErrors, consoleErrors } = getPageErrors(session.page);
    const criticalErrors = pageErrors.filter(e => !isIgnoredPageError(e));
    if (criticalErrors.length > 0 && !failed) {
      failed = true;
      stepResults.push({
        index: stepResults.length,
        step: { assertVisible: 'no-page-errors' },
        status: 'failed',
        message: `Page errors: ${criticalErrors.join('; ')}`,
        durationMs: 0,
        browserLogs: browserLogs.filter(log => log.type === 'pageerror'),
      });
    }

    if (browserLogs.length > 0) {
      writeFileSync(
        join(reportDir, 'browser-logs.json'),
        JSON.stringify({ browserLogs, consoleErrors, pageErrors }, null, 2)
      );
    }

    if (showProgress) {
      await updateProgressOverlay(session.page, {
        scenario: scenario.name,
        current: totalSteps,
        total: totalSteps,
        stepLabel: failed ? '测试未通过' : '全部步骤已完成',
        status: failed ? 'failed' : 'done',
        message: failed ? stepResults.at(-1)?.message : undefined,
      });
      const pauseMs = options.pauseOnFinishMs ?? 1500;
      if (pauseMs > 0) await session.page.waitForTimeout(pauseMs);
    }
  } finally {
    await session.close();
  }

  const finishedAt = new Date().toISOString();
  const result: ScenarioResult = {
    name: scenario.name,
    status: failed ? 'failed' : 'passed',
    steps: stepResults,
    startedAt,
    finishedAt,
    reportDir,
    browserLogs,
  };

  const visualReviewOptions =
    resolveVisualReviewOptions(scenario.visualReview) ??
    (options.visualReview ? {} : null);
  if (visualReviewOptions) {
    result.visualReview = await runScenarioVisualReview(scenario, result, visualReviewOptions);
    if (result.visualReview && shouldFailOnVisualAnalysis(result.visualReview.analysis, {
      strict: visualReviewOptions.strict,
      category: scenario.category,
    })) {
      result.status = 'failed';
      failed = true;
    }
  }

  writeFileSync(join(reportDir, 'result.json'), JSON.stringify(result, null, 2));
  return result;
};

export const runSmokeRoutes = async (
  routes: string[],
  options: { env?: string; device?: string; headless?: boolean } = {}
): Promise<ScenarioResult> => {
  const scenario: Scenario = {
    name: 'smoke',
    env: options.env ?? 'dev',
    viewport: options.device ?? 'mobile',
    steps: routes.map(path => ({ goto: path })),
  };
  return runScenario(scenario, { headless: options.headless });
};
