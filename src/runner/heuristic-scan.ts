import type { Scenario } from '../types.js';
import { runScenario } from './scenario-runner.js';
import type { ScenarioResult } from '../types.js';

export type UrlExploreOptions = {
  maxActions?: number;
  safeMode?: boolean;
  scroll?: boolean;
  fillInputs?: boolean;
  navigateBack?: boolean;
  aiMode?: boolean;
  goal?: string;
  env?: string;
  device?: string;
  autoLogin?: boolean | string;
};

const DEFAULT_EXPLORE = {
  maxActions: 12,
  safeMode: true,
  scroll: true,
  fillInputs: true,
  navigateBack: true,
  aiMode: true,
};

export const buildUrlExploreScenario = (
  urls: string[],
  options: UrlExploreOptions = {}
): Scenario => {
  if (urls.length === 0) {
    throw new Error('至少需要一个测试 URL');
  }

  const explore = {
    ...DEFAULT_EXPLORE,
    ...(options.maxActions != null ? { maxActions: options.maxActions } : {}),
    ...(options.safeMode != null ? { safeMode: options.safeMode } : {}),
    ...(options.scroll != null ? { scroll: options.scroll } : {}),
    ...(options.fillInputs != null ? { fillInputs: options.fillInputs } : {}),
    ...(options.navigateBack != null ? { navigateBack: options.navigateBack } : {}),
    ...(options.aiMode != null ? { aiMode: options.aiMode } : {}),
    ...(options.goal ? { goal: options.goal } : {}),
  };

  return {
    name: urls.length === 1 ? 'page-explore' : 'multi-page-explore',
    description:
      urls.length === 1
        ? `启发式探索: ${urls[0]}`
        : `启发式探索 ${urls.length} 个页面`,
    env: options.env ?? 'default',
    viewport: options.device ?? 'mobile',
    autoLogin: options.autoLogin ?? false,
    autoExplore: explore,
    steps: urls.map(url => ({ goto: url })),
  };
};

export const runUrlExploreScan = async (
  urls: string[],
  options: {
    maxActions?: number;
    env?: string;
    device?: string;
    account?: string;
    autoLogin?: boolean | string;
    headless?: boolean;
    showProgress?: boolean;
    slowMo?: number;
    reportRoot?: string;
  } = {}
): Promise<{ scenario: Scenario; result: ScenarioResult }> => {
  const autoLogin =
    options.autoLogin === false
      ? false
      : options.autoLogin ?? (options.account ? options.account : false);

  const scenario = buildUrlExploreScenario(urls, {
    maxActions: options.maxActions,
    env: options.env,
    device: options.device,
    autoLogin,
  });

  const result = await runScenario(scenario, {
    headless: options.headless,
    showProgress: options.showProgress,
    slowMo: options.slowMo,
    reportRoot: options.reportRoot,
  });

  return { scenario, result };
};

export const formatUrlExplorePlan = (urls: string[]): string => {
  if (urls.length === 1) {
    return `目标页面: ${urls[0]}`;
  }
  const lines = urls.map((url, i) => `  ${i + 1}. ${url}`);
  return [`共 ${urls.length} 个页面:`, ...lines].join('\n');
};
