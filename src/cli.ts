import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { parse as parseYaml } from 'yaml';
import { getRootDir } from './config.js';
import { runAgentTask } from './agent/executor.js';
import { formatExploreSummary, runPageExplore } from './agent/page-explorer.js';
import {
  formatSiteExploreSummary,
  runSiteExplore,
} from './agent/site-crawl.js';
import {
  generateTestsFromPage,
  scenariosFromGeneration,
  writeAutogenArtifacts,
} from './agent/test-generator.js';
import { createPlaywrightSession } from './runner/playwright-session.js';
import { runScenario } from './runner/scenario-runner.js';
import {
  formatUrlExplorePlan,
  runUrlExploreScan,
} from './runner/heuristic-scan.js';
import { writeConsolidatedReport, type ConsolidatedReportInput } from './reporters/consolidated-report.js';
import { writeHtmlReport } from './reporters/html-report.js';
import {
  closeReportServer,
  getReportServerBaseUrl,
  openReportInChrome,
  waitForReportServerExit,
} from './reporters/report-server.js';
import { ScenarioSchema, type ScenarioResult } from './types.js';
import { gotoWithAuth } from './auth/navigate-with-auth.js';
import { isAuthTestPath } from './auth/auto-login.js';
import { listAccounts, resolveAccount } from './credentials.js';
import { resolveHeadless, resolveOpenReport, resolveShowProgress, resolveSlowMo, resolveVisualReview, type OpenReportMode } from './runner/run-options.js';
import { analyzeReportTarget, findLatestRegressionSummary } from './reporters/analyze-report.js';
import {
  applyTargetBaseUrl,
  resolveTargetUrl,
  resolveTargetUrls,
} from './prompt/target-url.js';
import {
  formatPlatformLine,
  parsePlatform,
  platformToDevice,
  resolveSessionDevice,
} from './prompt/platform.js';
import {
  formatRuntimeAuthLine,
  resolveRuntimeAuth,
  shouldEnableAutoLogin,
} from './prompt/credentials-prompt.js';
import { setRuntimeCredentials } from './auth/runtime-credentials.js';
import {
  formatStepLabel,
  updateProgressOverlay,
  capturePageScreenshot,
} from './runner/progress-overlay.js';

loadEnv({ path: join(getRootDir(), '.env') });

const getUserArgs = (): string[] => {
  const argv = process.argv.slice(2);
  if (argv[0]?.endsWith('cli.ts') || argv[0]?.endsWith('cli.js')) {
    return argv.slice(1);
  }
  return argv;
};

const parseArgs = (argv: string[]) => {
  const args = [...argv];
  const command = args.shift() ?? 'help';
  const flags: Record<string, string> = {};
  const positional: string[] = [];

  while (args.length > 0) {
    const arg = args.shift();
    if (!arg) break;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[0];
      const value = next && !next.startsWith('--') ? args.shift()! : 'true';
      flags[key] = value;
    } else {
      positional.push(arg);
    }
  }

  return { command, flags, positional };
};

const loadScenarioFile = (filePath: string) => {
  const fullPath = filePath.startsWith('/')
    ? filePath
    : join(process.cwd(), filePath);
  const raw = readFileSync(fullPath, 'utf8');
  const parsed = parseYaml(raw);
  return ScenarioSchema.parse(parsed);
};

const loadSuiteFile = (filePath: string) => {
  const fullPath = filePath.startsWith('/')
    ? filePath
    : join(getRootDir(), filePath);
  const raw = readFileSync(fullPath, 'utf8');
  const parsed = parseYaml(raw) as {
    name: string;
    description?: string;
    cases: Array<{
      path: string;
      priority?: string;
      category?: string;
      module?: string;
      tags?: string[];
      enabled?: boolean;
    }>;
  };
  if (!parsed.cases?.length) {
    throw new Error(`Suite has no cases: ${fullPath}`);
  }
  return parsed;
};

const loadBrowserLogsFromReportDir = (reportDir: string): ScenarioResult['browserLogs'] => {
  const browserLogsPath = join(reportDir, 'browser-logs.json');
  if (existsSync(browserLogsPath)) {
    const parsed = JSON.parse(readFileSync(browserLogsPath, 'utf8')) as {
      browserLogs?: ScenarioResult['browserLogs'];
    };
    if (parsed.browserLogs?.length) return parsed.browserLogs;
  }

  const legacyPath = join(reportDir, 'console-errors.json');
  if (!existsSync(legacyPath)) return undefined;

  const parsed = JSON.parse(readFileSync(legacyPath, 'utf8')) as {
    consoleErrors?: string[];
    pageErrors?: string[];
  };
  const timestamp = new Date().toISOString();
  const logs: NonNullable<ScenarioResult['browserLogs']> = [];
  for (const message of parsed.consoleErrors ?? []) {
    logs.push({ type: 'console', level: 'error', message, timestamp });
  }
  for (const message of parsed.pageErrors ?? []) {
    logs.push({ type: 'pageerror', level: 'error', message, timestamp });
  }
  return logs.length > 0 ? logs : undefined;
};

const enrichScenarioResult = (result: ScenarioResult): ScenarioResult => {
  if (result.browserLogs?.length) return result;
  const browserLogs = loadBrowserLogsFromReportDir(result.reportDir);
  return browserLogs?.length ? { ...result, browserLogs } : result;
};

const loadConsolidatedCasesFromSummary = (summaryPath: string): ConsolidatedReportInput => {
  const raw = readFileSync(summaryPath, 'utf8');
  const parsed = JSON.parse(raw) as {
    suite: string;
    description?: string;
    startedAt?: string;
    finishedAt?: string;
    cases?: Array<{
      path: string;
      priority?: string;
      category?: string;
      name: string;
      status: 'passed' | 'failed';
      startedAt?: string;
      finishedAt?: string;
      reportDir: string;
      message?: string;
      steps?: ScenarioResult['steps'];
    }>;
    summary?: Array<{
      path: string;
      name: string;
      status: 'passed' | 'failed';
      reportDir: string;
      message?: string;
    }>;
  };

  const entries = parsed.cases ?? parsed.summary ?? [];
  const cases = entries.map(entry => {
    const resultJsonPath = join(entry.reportDir, 'result.json');
    if (existsSync(resultJsonPath)) {
      const typedEntry = entry as {
        path: string;
        priority?: string;
        category?: string;
        reportDir: string;
      };
      const result = enrichScenarioResult(
        JSON.parse(readFileSync(resultJsonPath, 'utf8')) as ScenarioResult
      );
      return {
        path: typedEntry.path,
        priority: typedEntry.priority,
        category: typedEntry.category,
        result,
      };
    }

    const legacy = entry as {
      path: string;
      name: string;
      status: 'passed' | 'failed';
      reportDir: string;
      message?: string;
      steps?: ScenarioResult['steps'];
      startedAt?: string;
      finishedAt?: string;
    };

    const now = new Date().toISOString();
    const result: ScenarioResult = {
      name: legacy.name,
      status: legacy.status,
      reportDir: legacy.reportDir,
      startedAt: legacy.startedAt ?? now,
      finishedAt: legacy.finishedAt ?? now,
      steps:
        legacy.steps ??
        (legacy.message
          ? [
              {
                index: 0,
                step: { assertVisible: 'scenario' },
                status: 'failed' as const,
                message: legacy.message,
                durationMs: 0,
              },
            ]
          : []),
    };

    const enriched = enrichScenarioResult(result);

    return {
      path: legacy.path,
      priority: 'priority' in legacy ? (legacy as { priority?: string }).priority : undefined,
      category: 'category' in legacy ? (legacy as { category?: string }).category : undefined,
      result: enriched,
    };
  });

  return {
    suite: parsed.suite,
    description: parsed.description,
    startedAt: parsed.startedAt ?? cases[0]?.result.startedAt ?? new Date().toISOString(),
    finishedAt:
      parsed.finishedAt ?? cases.at(-1)?.result.finishedAt ?? new Date().toISOString(),
    cases,
  };
};

const printHelp = () => {
  console.log(`
Omnipage AI (omnipage-ai) — AI 智能测试任意 H5 / Web 页面

Usage:
  pnpm explore [--url <url>] [--max-actions 30] [--max-pages 30] [--no-crawl] [--account e2e] [--no-login] [--headless]
  pnpm scan [--url <url>] [--urls a,b,c] [--max-actions 12] [--max-pages 30] [--no-crawl] [--account e2e] [--no-login] [--headless]
  pnpm agent --url <url> --task "<natural language task>" [--account e2e] [--headless]
  pnpm autogen [--url <url>] [--goal "测试目标"] [--no-run] [--account e2e] [--no-login] [--headless]
  pnpm run <scenario.yaml> [--env default] [--device mobile] [--headless]
  pnpm regression <suite.yaml> [--priority P0] [--category normal|abnormal|edge] [--headless]
  pnpm visual-review [reports/xxx/summary.json | case-report-dir]
  pnpm aggregate [reports/xxx/summary.json]
  pnpm accounts

未传 --url 时，启动后会提示输入要测试的页面链接。

Options:
  --headed            显示可视化浏览器（本地默认已开启）
  --headless          无头模式（CI 默认）
  --progress false    关闭页面内进度浮层
  --slow-mo 500       操作放慢（毫秒，便于观察）
  --open-report       测试完成后用 Chrome 打开报告
  --open-report each  回归时每个用例完成后都打开报告
  --open-report false 不打开报告
  --visual-review     测试完成后 AI 分析截图并写入报告
  --env default       环境配置（见 config/environments.yaml，URL 会自动设置 baseURL）
  --platform h5|web   页面类型：h5 使用手机小屏，web 使用桌面大屏（未传时会提示）
  --email <id>        登录账号或邮箱（遇登录页时填入账号/用户名/邮箱框；未传时会提示）
  --password <pwd>    登录密码（与 --email 配合）
  --no-login          禁用自动登录
  --max-pages 30      全站探索时最多测试页面数（默认逐个跳转站内链接）
  --no-crawl          仅测试当前 URL，不自动跳转其他页面
  --device mobile     高级：直接指定设备名，覆盖 --platform（mobile | desktop | webview-ios）

Examples:
  pnpm explore
  pnpm explore --url https://example.com/login --platform h5
  pnpm explore --url https://example.com --platform web --max-actions 20
  pnpm scan --urls https://a.com/,https://a.com/about
  pnpm agent --url https://example.com --task "点击第一个按钮并填写表单"
  pnpm autogen --url https://example.com/pricing --goal "测试订阅流程"
  pnpm run examples/smoke.yaml
`);
};

const authDisabled = (flags: Record<string, string>) => flags['no-login'] === 'true';

const crawlDisabled = (flags: Record<string, string>) => flags['no-crawl'] === 'true';

const resolveMaxPages = (flags: Record<string, string>) => {
  const raw = flags['max-pages'];
  if (!raw) return 30;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 30;
};

const initRuntimeAuth = async (flags: Record<string, string>) => {
  const resolved = await resolveRuntimeAuth(flags);
  setRuntimeCredentials(resolved.credentials);
  return resolved;
};

const buildRunOptions = (flags: Record<string, string>) => {
  let headless: boolean | undefined;
  if (flags.headless === 'true') headless = true;
  else if (flags.headless === 'false' || flags.headed === 'true') headless = false;

  const resolvedHeadless = resolveHeadless(headless);
  const slowMoFlag = flags['slow-mo'] ?? flags.slowMo;

  return {
    headless: resolvedHeadless,
    showProgress: resolveShowProgress(resolvedHeadless, flags.progress),
    slowMo: slowMoFlag ? Number(slowMoFlag) : resolveSlowMo(resolvedHeadless),
    pauseOnFinishMs: flags.pause === 'false' ? 0 : undefined,
    openReport: resolveOpenReport(resolvedHeadless, flags['open-report']),
    visualReview: resolveVisualReview(flags['visual-review']),
  };
};

const finishWithReport = async (
  htmlPath: string,
  exitCode: number,
  openReport: OpenReportMode
) => {
  if (!openReport) {
    process.exit(exitCode);
    return;
  }

  try {
    const url = await openReportInChrome(htmlPath);
    console.log(`\n报告已在 Chrome 打开: ${url}`);
    console.log(`本地报告服务: ${getReportServerBaseUrl()} — 按 Ctrl+C 退出`);
    await waitForReportServerExit();
    await closeReportServer();
  } catch (err) {
    console.warn(
      `无法自动打开 Chrome: ${err instanceof Error ? err.message : String(err)}`
    );
    console.log(`请手动打开报告: ${htmlPath}`);
  }

  process.exit(exitCode);
};

const main = async () => {
  const { command, flags, positional } = parseArgs(getUserArgs());
  const runOptions = buildRunOptions(flags);

  switch (command) {
    case 'smoke':
    case 'heuristic':
    case 'scan': {
      const urls = await resolveTargetUrls({
        url: flags.url,
        urls: flags.urls,
        prompt: '请输入要测试的页面 URL（多个用逗号分隔）: ',
      });
      applyTargetBaseUrl(urls[0]!);

      const runtimeAuth = await initRuntimeAuth(flags);
      const { deviceName, platform } = await resolveSessionDevice(flags);
      const maxActions = flags['max-actions'] ? Number(flags['max-actions']) : undefined;
      const maxPages = resolveMaxPages(flags);
      const envName = flags.env ?? 'default';
      const autoLogin = shouldEnableAutoLogin(flags, runtimeAuth.credentials);

      console.log(`URL 探索扫描`);
      console.log(formatUrlExplorePlan(urls));
      console.log(formatPlatformLine(platform, deviceName));
      console.log(formatRuntimeAuthLine(runtimeAuth));
      if (maxActions != null) console.log(`maxActions per page: ${maxActions}`);
      if (!crawlDisabled(flags) && urls.length === 1) {
        console.log(`全站模式: 测完当前页后自动跳转站内链接，最多 ${maxPages} 页`);
      }
      if (autoLogin && typeof autoLogin === 'string' && !runtimeAuth.credentials) {
        const account = resolveAccount(autoLogin, envName);
        console.log(`Login account: ${account.email} (${account.name})`);
      }
      console.log('');
      if (!runOptions.headless) {
        console.log('可视化模式：对每个页面自动启发式探索\n');
      }

      if (!crawlDisabled(flags) && urls.length === 1) {
        const seedUrl = urls[0]!;
        const session = await createPlaywrightSession({
          envName,
          deviceName,
          headless: runOptions.headless,
          slowMo: runOptions.slowMo,
          showProgress: runOptions.showProgress,
        });

        const skipAuth = authDisabled(flags) || isAuthTestPath(seedUrl);
        await gotoWithAuth(session.page, seedUrl, {
          envName,
          account: typeof autoLogin === 'string' ? autoLogin : undefined,
          disabled: skipAuth,
        });

        const reportDir = join(getRootDir(), 'reports', `site-explore-${Date.now()}`);
        const { mkdirSync } = await import('node:fs');
        mkdirSync(reportDir, { recursive: true });

        const siteReport = await runSiteExplore(session.page, {
          seedUrl,
          maxPages,
          maxActions: maxActions ?? 12,
          envName,
          account: typeof autoLogin === 'string' ? autoLogin : undefined,
          authDisabled: skipAuth,
          reportDir,
          onAction: (current, total, label) => {
            console.log(`  [explore ${current}/${total}] ${label}`);
          },
        });

        await session.close();
        const htmlPath = join(reportDir, 'index.html');
        console.log(`\n${formatSiteExploreSummary(siteReport)}`);
        console.log(`HTML 报告: ${htmlPath}`);
        await finishWithReport(htmlPath, 0, runOptions.openReport);
        break;
      }

      const { scenario, result } = await runUrlExploreScan(urls, {
        maxActions,
        env: envName,
        device: deviceName,
        account: typeof autoLogin === 'string' ? autoLogin : undefined,
        autoLogin: autoLogin || undefined,
        headless: runOptions.headless,
        showProgress: runOptions.showProgress,
        slowMo: runOptions.slowMo,
      });

      const htmlPath = writeHtmlReport(result);
      console.log(`\nScan ${result.status}: ${htmlPath}`);
      console.log(`Pages scanned: ${scenario.steps.length}`);
      await finishWithReport(htmlPath, result.status === 'passed' ? 0 : 1, runOptions.openReport);
      break;
    }

    case 'run': {
      const scenarioPath = positional[0];
      if (!scenarioPath) {
        console.error('Missing scenario file. Usage: pnpm qa run scenarios/foo.yaml');
        process.exit(1);
      }
      await initRuntimeAuth(flags);
      const scenario = loadScenarioFile(scenarioPath);
      if (flags.env) scenario.env = flags.env;
      if (flags.device) scenario.viewport = flags.device;
      else if (flags.platform) scenario.viewport = platformToDevice(parsePlatform(flags.platform));

      console.log(`Running scenario: ${scenario.name}`);
      if (!runOptions.headless) {
        console.log('可视化模式：将打开浏览器，页面右上角显示测试进度');
      }
      const result = await runScenario(scenario, runOptions);
      const htmlPath = writeHtmlReport(result);
      console.log(`\nScenario ${result.status}: ${htmlPath}`);
      await finishWithReport(htmlPath, result.status === 'passed' ? 0 : 1, runOptions.openReport);
      break;
    }

    case 'agent': {
      const url = await resolveTargetUrl(flags.url, '请输入 Agent 要访问的页面 URL: ');
      applyTargetBaseUrl(url);
      const runtimeAuth = await initRuntimeAuth(flags);
      const task = flags.task;
      if (!task) {
        console.error('Usage: pnpm agent --url <url> --task "<task>" [--account e2e]');
        process.exit(1);
      }

      const envName = flags.env ?? 'default';
      const { deviceName, platform } = await resolveSessionDevice(flags);
      console.log(formatPlatformLine(platform, deviceName));
      console.log(formatRuntimeAuthLine(runtimeAuth));
      const session = await createPlaywrightSession({
        envName,
        deviceName,
        headless: runOptions.headless,
        slowMo: runOptions.slowMo,
        showProgress: runOptions.showProgress,
      });

      await gotoWithAuth(session.page, url, {
        envName,
        account: flags.account,
        disabled: authDisabled(flags),
      });

      console.log(`Agent task: ${task}`);
      const { history, summary } = await runAgentTask(session.page, task, {
        envName,
        account: flags.account,
        authDisabled: authDisabled(flags),
        onStep: (i, action) => {
          console.log(`  step ${i + 1}:`, action);
          if (!runOptions.showProgress) return;
          void updateProgressOverlay(session.page, {
            scenario: 'agent',
            current: i + 1,
            total: 12,
            stepLabel: formatStepLabel({ agent: JSON.stringify(action) }),
            status: 'running',
          });
        },
      });

      if (runOptions.showProgress) {
        await updateProgressOverlay(session.page, {
          scenario: 'agent',
          current: 12,
          total: 12,
          stepLabel: summary,
          status: 'done',
        });
        await session.page.waitForTimeout(1500);
      }

      const reportDir = join(getRootDir(), 'reports', `agent-${Date.now()}`);
      const { mkdirSync, writeFileSync } = await import('node:fs');
      mkdirSync(reportDir, { recursive: true });
      await capturePageScreenshot(session.page, {
        path: join(reportDir, 'final.png'),
        fullPage: true,
      });
      writeFileSync(
        join(reportDir, 'history.json'),
        JSON.stringify({ task, url, summary, history }, null, 2)
      );

      await session.close();
      console.log(`\nAgent done: ${summary}`);
      console.log(`Report: ${reportDir}`);
      process.exit(0);
      break;
    }

    case 'explore': {
      const url = await resolveTargetUrl(flags.url);
      applyTargetBaseUrl(url);
      const runtimeAuth = await initRuntimeAuth(flags);

      const envName = flags.env ?? 'default';
      const { deviceName, platform } = await resolveSessionDevice(flags);
      console.log(formatPlatformLine(platform, deviceName));
      console.log(formatRuntimeAuthLine(runtimeAuth));
      const session = await createPlaywrightSession({
        envName,
        deviceName,
        headless: runOptions.headless,
        slowMo: runOptions.slowMo,
        showProgress: runOptions.showProgress,
      });

      const skipAuth = authDisabled(flags) || isAuthTestPath(url);
      await gotoWithAuth(session.page, url, {
        envName,
        account: flags.account,
        disabled: skipAuth,
      });

      const reportDir = join(getRootDir(), 'reports', `explore-${Date.now()}`);
      const { mkdirSync } = await import('node:fs');
      mkdirSync(reportDir, { recursive: true });

      const maxActions = flags['max-actions'] ? Number(flags['max-actions']) : 30;
      const maxPages = resolveMaxPages(flags);
      const useSiteCrawl = !crawlDisabled(flags);

      if (useSiteCrawl) {
        console.log(`全站探索: ${url}（最多 ${maxPages} 页，测完自动跳转站内链接）`);
        const siteReport = await runSiteExplore(session.page, {
          seedUrl: url,
          maxPages,
          maxActions,
          envName,
          account: flags.account,
          authDisabled: skipAuth,
          reportDir,
          onAction: (current, total, label) => {
            console.log(`  [${current}/${total}] ${label}`);
          },
        });

        await capturePageScreenshot(session.page, {
          path: join(reportDir, 'final.png'),
          fullPage: true,
        });

        await session.close();
        console.log(`\n${formatSiteExploreSummary(siteReport)}`);
        console.log(`HTML 报告: ${join(reportDir, 'index.html')}`);
        await finishWithReport(join(reportDir, 'index.html'), 0, runOptions.openReport);
        break;
      }

      console.log(`Exploring page: ${url}`);
      const report = await runPageExplore(session.page, {
        maxActions,
        envName,
        account: flags.account,
        authDisabled: skipAuth,
        reportDir,
        onAction: (current, total, label) => {
          console.log(`  [${current}/${total}] ${label}`);
        },
      });

      await capturePageScreenshot(session.page, {
        path: join(reportDir, 'final.png'),
        fullPage: true,
      });

      const htmlPath = join(reportDir, 'index.html');

      await session.close();
      console.log(`\n${formatExploreSummary(report)}`);
      console.log(`HTML 报告: ${htmlPath}`);
      await finishWithReport(htmlPath, 0, runOptions.openReport);
      break;
    }

    case 'autogen': {
      const url = await resolveTargetUrl(flags.url, '请输入要分析并生成用例的页面 URL: ');
      applyTargetBaseUrl(url);
      const runtimeAuth = await initRuntimeAuth(flags);

      const envName = flags.env ?? 'default';
      const { deviceName, platform } = await resolveSessionDevice(flags);
      console.log(formatPlatformLine(platform, deviceName));
      console.log(formatRuntimeAuthLine(runtimeAuth));
      const reportDir = join(getRootDir(), 'reports', `autogen-${Date.now()}`);
      const { mkdirSync } = await import('node:fs');
      mkdirSync(reportDir, { recursive: true });

      const session = await createPlaywrightSession({
        envName,
        deviceName,
        headless: runOptions.headless,
        slowMo: runOptions.slowMo,
        showProgress: runOptions.showProgress,
      });

      const skipAuth = authDisabled(flags) || isAuthTestPath(url);
      await gotoWithAuth(session.page, url, {
        envName,
        account: flags.account,
        disabled: skipAuth,
        waitMs: 2000,
      });

      console.log(`Analyzing page: ${session.page.url()}`);
      const generation = await generateTestsFromPage(session.page, {
        reportDir,
        env: envName,
        viewport: deviceName,
        goal: flags.goal,
        maxScenarios: flags['max-scenarios'] ? Number(flags['max-scenarios']) : 3,
      });

      const scenarios = scenariosFromGeneration(generation, {
        reportDir,
        env: envName,
        viewport: deviceName,
      });

      writeAutogenArtifacts(generation, scenarios, reportDir);

      console.log(`\n页面: ${generation.pageSummary}`);
      console.log(`识别功能: ${generation.detectedFeatures.join(', ')}`);
      if (generation.testIdeas?.length) {
        console.log(`测试建议: ${generation.testIdeas.join('; ')}`);
      }
      console.log(`\n生成 ${scenarios.length} 个场景:`);
      for (const scenario of scenarios) {
        console.log(`  • ${scenario.name} (${scenario.category}): ${scenario.description}`);
        console.log(`    ${join(reportDir, `${scenario.name}.yaml`)}`);
      }
      console.log(`\n报告: ${join(reportDir, 'index.html')}`);

      await session.close();

      const skipRun = flags['no-run'] === 'true' || flags['no-run'] === '';
      if (!skipRun && scenarios.length > 0) {
        const { writeFileSync } = await import('node:fs');
        const runStartedAt = new Date().toISOString();
        const runResults: Array<{ path: string; category?: string; result: ScenarioResult }> = [];

        const runOutputDir = join(reportDir, 'run');
        const { mkdirSync: mkdirRun } = await import('node:fs');
        mkdirRun(runOutputDir, { recursive: true });

        console.log(`\n━━━ 立即执行 ${scenarios.length} 个生成场景 ━━━`);
        for (let i = 0; i < scenarios.length; i += 1) {
          const scenario = scenarios[i];
          const yamlPath = join(reportDir, `${scenario.name}.yaml`);
          console.log(`\n[${i + 1}/${scenarios.length}] ${scenario.name}`);
          const result = await runScenario(scenario, {
            ...runOptions,
            reportRoot: runOutputDir,
          });
          const htmlPath = writeHtmlReport(result);
          writeFileSync(join(result.reportDir, 'result.json'), JSON.stringify(result, null, 2));
          runResults.push({
            path: yamlPath,
            category: scenario.category,
            result,
          });
          console.log(`${result.status === 'passed' ? '✓' : '✗'} ${result.name}: ${htmlPath}`);
        }

        const runFinishedAt = new Date().toISOString();
        const passed = runResults.filter(r => r.result.status === 'passed').length;
        const failed = runResults.length - passed;

        const { htmlPath } = writeConsolidatedReport(
          {
            suite: 'autogen-run',
            description: `AI 自动生成并执行 — ${generation.pageSummary}`,
            startedAt: runStartedAt,
            finishedAt: runFinishedAt,
            cases: runResults.map(r => ({
              path: r.path,
              category: r.category,
              result: r.result,
            })),
          },
          runOutputDir
        );

        console.log(`\n执行结果: ${passed}/${runResults.length} passed`);
        console.log(`分析报告: ${join(reportDir, 'index.html')}`);
        console.log(`执行汇总: ${htmlPath}`);
        await finishWithReport(htmlPath, failed === 0 ? 0 : 1, runOptions.openReport);
        break;
      }

      if (runOptions.openReport) {
        await finishWithReport(join(reportDir, 'index.html'), 0, runOptions.openReport);
      } else {
        process.exit(0);
      }
      break;
    }

    case 'regression': {
      const suitePath = positional[0];
      if (!suitePath) {
        console.error('Usage: pnpm regression <suite.yaml> [--priority P0] [--category normal]');
        process.exit(1);
      }
      await initRuntimeAuth(flags);
      const priorityFilter = flags.priority;
      const categoryFilter = flags.category;
      const suite = loadSuiteFile(suitePath);
      const cases = suite.cases.filter(item => {
        if (item.enabled === false) return false;
        if (priorityFilter && item.priority !== priorityFilter) return false;
        if (categoryFilter && item.category !== categoryFilter) return false;
        return true;
      });

      if (cases.length === 0) {
        console.error(`No cases to run in suite ${suitePath}`);
        process.exit(1);
      }

      console.log(`Regression suite: ${suite.name}`);
      if (suite.description) console.log(suite.description);
      if (priorityFilter) console.log(`Filter priority: ${priorityFilter}`);
      if (categoryFilter) console.log(`Filter category: ${categoryFilter}`);
      console.log(`Cases: ${cases.length}\n`);
      if (!runOptions.headless) {
        console.log('可视化模式：将打开浏览器，页面右上角显示测试进度\n');
      }

      const reportRoot = join(getRootDir(), 'reports', `regression-${Date.now()}`);
      const { mkdirSync, writeFileSync } = await import('node:fs');
      mkdirSync(reportRoot, { recursive: true });

      const consolidatedCases: Array<{
        path: string;
        priority?: string;
        category?: string;
        result: ScenarioResult;
      }> = [];
      const startedAt = new Date().toISOString();

      for (let i = 0; i < cases.length; i += 1) {
        const item = cases[i];
        console.log(`\n━━━ [${i + 1}/${cases.length}] ${item.path} (${item.priority ?? '-'} / ${item.category ?? '-'}) ━━━`);
        const scenario = loadScenarioFile(item.path);
        if (flags.env) scenario.env = flags.env;
        if (flags.device) scenario.viewport = flags.device;
        else if (flags.platform) scenario.viewport = platformToDevice(parsePlatform(flags.platform));
        const result = await runScenario(scenario, runOptions);
        const caseHtmlPath = writeHtmlReport(result);
        writeFileSync(join(result.reportDir, 'result.json'), JSON.stringify(result, null, 2));
        consolidatedCases.push({
          path: item.path,
          priority: item.priority,
          category: item.category,
          result,
        });
        console.log(`${result.status === 'passed' ? '✓' : '✗'} ${result.name}: ${result.reportDir}`);
        if (runOptions.openReport === 'each') {
          try {
            const url = await openReportInChrome(caseHtmlPath);
            console.log(`  → 报告已打开: ${url}`);
          } catch (err) {
            console.warn(
              `  → 无法打开报告: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
      }

      const finishedAt = new Date().toISOString();
      const passed = consolidatedCases.filter(c => c.result.status === 'passed').length;
      const failed = consolidatedCases.length - passed;

      const { htmlPath, jsonPath } = writeConsolidatedReport(
        {
          suite: suite.name,
          description: suite.description,
          startedAt,
          finishedAt,
          cases: consolidatedCases,
        },
        reportRoot
      );

      console.log(`\n════════════════════════════════════`);
      console.log(`Regression ${failed === 0 ? 'PASSED' : 'FAILED'}: ${passed}/${consolidatedCases.length} passed`);
      for (const item of consolidatedCases) {
        const icon = item.result.status === 'passed' ? '✓' : '✗';
        console.log(`  ${icon} ${item.path}`);
        const message = item.result.steps.find(s => s.status === 'failed')?.message;
        if (message) console.log(`      ${message}`);
      }

      console.log(`\n汇总报告: ${htmlPath}`);
      console.log(`汇总数据: ${jsonPath}`);
      const openMode = runOptions.openReport === 'each' ? true : runOptions.openReport;
      await finishWithReport(htmlPath, failed === 0 ? 0 : 1, openMode);
      break;
    }

    case 'visual-review': {
      const target =
        positional[0] ??
        findLatestRegressionSummary() ??
        (() => {
          console.error(
            'No report found. Usage: pnpm qa visual-review [reports/regression-xxx/summary.json | case-report-dir]'
          );
          process.exit(1);
        })();

      const { htmlPath, count } = await analyzeReportTarget(target, {
        strict: flags.strict === 'true',
        prompt: flags.prompt,
      });
      console.log(`\n已完成 ${count} 个用例的 AI 视觉分析`);
      console.log(`报告: ${htmlPath}`);
      await finishWithReport(htmlPath, 0, runOptions.openReport);
      break;
    }

    case 'aggregate': {
      const summaryPath =
        positional[0] ??
        findLatestRegressionSummary() ??
        (() => {
          console.error('No regression summary found. Usage: pnpm qa aggregate [reports/regression-xxx/summary.json]');
          process.exit(1);
        })();

      const input = loadConsolidatedCasesFromSummary(summaryPath);
      const outputDir = join(summaryPath, '..');
      const { htmlPath, jsonPath } = writeConsolidatedReport(input, outputDir);

      console.log(`Aggregated ${input.cases.length} cases from ${summaryPath}`);
      console.log(`汇总报告: ${htmlPath}`);
      console.log(`汇总数据: ${jsonPath}`);
      await finishWithReport(htmlPath, 0, runOptions.openReport);
      break;
    }

    case 'accounts': {
      const envName = flags.env;
      const accounts = listAccounts(envName);
      if (accounts.length === 0) {
        console.log('No accounts configured. Copy config/accounts.example.yaml to config/accounts.yaml');
        process.exit(0);
      }
      console.log('Available accounts:');
      for (const account of accounts) {
        const envs = account.env?.length ? account.env.join(', ') : 'all';
        const desc = account.description ? ` — ${account.description}` : '';
        console.log(`  ${account.name}: ${account.email} [env: ${envs}]${desc}`);
      }
      process.exit(0);
      break;
    }

    case 'help':
    default:
      if (command === 'help') {
        printHelp();
        process.exit(0);
      }
      // 无子命令时默认进入单页探索，并提示输入 URL
      {
        const url = await resolveTargetUrl(undefined);
        applyTargetBaseUrl(url);
        const runtimeAuth = await initRuntimeAuth(flags);
        const envName = flags.env ?? 'default';
        const { deviceName, platform } = await resolveSessionDevice(flags);
        console.log(formatPlatformLine(platform, deviceName));
        console.log(formatRuntimeAuthLine(runtimeAuth));
        const session = await createPlaywrightSession({
          envName,
          deviceName,
          headless: runOptions.headless,
          slowMo: runOptions.slowMo,
          showProgress: runOptions.showProgress,
        });
        const skipAuth = authDisabled(flags) || isAuthTestPath(url);
        await gotoWithAuth(session.page, url, {
          envName,
          account: flags.account,
          disabled: skipAuth,
        });
        const reportDir = join(getRootDir(), 'reports', `explore-${Date.now()}`);
        const { mkdirSync } = await import('node:fs');
        mkdirSync(reportDir, { recursive: true });
        const maxActions = flags['max-actions'] ? Number(flags['max-actions']) : 30;
        console.log(`Exploring page: ${url}`);
        const report = await runPageExplore(session.page, {
          maxActions,
          envName,
          account: flags.account,
          authDisabled: skipAuth,
          reportDir,
          onAction: (current, total, label) => {
            console.log(`  [${current}/${total}] ${label}`);
          },
        });
        await capturePageScreenshot(session.page, {
          path: join(reportDir, 'final.png'),
          fullPage: true,
        });
        await session.close();
        console.log(`\n${formatExploreSummary(report)}`);
        console.log(`HTML 报告: ${join(reportDir, 'index.html')}`);
        await finishWithReport(join(reportDir, 'index.html'), 0, runOptions.openReport);
      }
      break;
  }
};

main().catch(err => {
  console.error(err);
  process.exit(1);
});
