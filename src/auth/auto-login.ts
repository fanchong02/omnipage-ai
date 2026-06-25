import type { Page } from '@playwright/test';
import { resolveLoginAccount, tryResolveLoginAccount } from '../credentials.js';
import type { Scenario } from '../types.js';
import { isLikelyLoginForm } from './login-form.js';
import { performLogin } from './login.js';

export const isLoginPage = async (page: Page): Promise<boolean> => {
  if (/\/login(?:[/?#]|$)/i.test(page.url())) return true;

  if (!(await isLikelyLoginForm(page))) {
    const welcomeBack = page.getByText('Welcome Back', { exact: false }).first();
    const signIn = page.getByRole('button', { name: /sign in|log in|登录/i }).first();
    const hasWelcome = await welcomeBack.isVisible().catch(() => false);
    const hasSignIn = await signIn.isVisible().catch(() => false);
    return hasWelcome && hasSignIn;
  }

  const loginBtn = page
    .getByRole('button', { name: /sign in|log in|login|登录|登入|submit/i })
    .first();
  if (await loginBtn.isVisible().catch(() => false)) return true;

  const accountHints = page.getByText(/账号|用户名|邮箱|password|密码/i).first();
  return accountHints.isVisible().catch(() => false);
};

const pathnameOf = (urlOrPath: string) => {
  try {
    if (urlOrPath.startsWith('http')) return new URL(urlOrPath).pathname;
    return urlOrPath.split('?')[0].split('#')[0];
  } catch {
    return urlOrPath;
  }
};

/** 目标页本身就是登录/鉴权 UI 测试页，不应自动登录 */
const AUTH_TEST_PATH_PATTERN =
  /^\/(login|forgot-password|manage-password|onboarding\/entry-email|onboarding\/entry-name)(?:\/|$)/i;

export const isAuthTestPath = (urlOrPath: string): boolean =>
  AUTH_TEST_PATH_PATTERN.test(pathnameOf(urlOrPath));

export const shouldAutoLogin = (scenario: Scenario): boolean => {
  if (scenario.autoLogin === false) return false;
  if (scenario.steps.some(s => 'seedAuth' in s)) return false;
  if (scenario.autoLogin === true || typeof scenario.autoLogin === 'string') return true;

  if (scenario.module?.startsWith('auth/login')) return false;
  if (scenario.steps.some(s => 'assertUrl' in s && s.assertUrl.includes('login'))) {
    return false;
  }
  if (scenario.category === 'abnormal' && !scenario.steps.some(s => 'seedAuth' in s)) {
    return false;
  }

  return true;
};

export const shouldSkipAutoLogin = (input: {
  disabled?: boolean;
  scenario?: Scenario;
  intendedPath?: string;
}): boolean => {
  if (input.disabled) return true;

  if (input.intendedPath && isAuthTestPath(input.intendedPath)) {
    return true;
  }

  const scenario = input.scenario;
  if (!scenario) return false;

  if (scenario.autoLogin === false) return true;
  if (scenario.steps.some(s => 'seedAuth' in s)) return true;

  if (scenario.module?.startsWith('auth/login')) {
    const intended = input.intendedPath ? pathnameOf(input.intendedPath) : '';
    if (intended.includes('/login')) return true;
  }

  if (scenario.category === 'abnormal') {
    if (scenario.steps.some(s => 'assertUrl' in s && /login/i.test(s.assertUrl))) {
      return true;
    }
    if (!scenario.steps.some(s => 'seedAuth' in s || 'login' in s)) {
      return true;
    }
  }

  return false;
};

export const resolveAutoLoginAccount = (scenario: Scenario, envName: string) => {
  const accountName = typeof scenario.autoLogin === 'string' ? scenario.autoLogin : undefined;
  return resolveLoginAccount(accountName, envName);
};

export type EnsureLoggedInOptions = {
  envName: string;
  account?: string;
  scenario?: Scenario;
  intendedPath?: string;
  returnTo?: string;
  disabled?: boolean;
};

export const ensureLoggedIn = async (
  page: Page,
  options: EnsureLoggedInOptions
): Promise<boolean> => {
  if (shouldSkipAutoLogin(options)) return false;

  let onLogin = await isLoginPage(page);
  if (!onLogin) {
    await page
      .locator('input[type="password"]')
      .first()
      .waitFor({ state: 'visible', timeout: 5000 })
      .catch(() => undefined);
    onLogin = await isLoginPage(page);
  }
  if (!onLogin) return false;

  const account = options.scenario
    ? resolveAutoLoginAccount(
        {
          ...options.scenario,
          autoLogin: options.scenario.autoLogin ?? options.account ?? true,
        },
        options.envName
      )
    : tryResolveLoginAccount(options.account, options.envName);

  if (!account?.password) {
    console.warn('  [auth] 检测到登录页，但未配置密码（启动时 --email/--password 或 config/accounts.yaml）');
    return false;
  }

  console.log(`  [auth] 检测到未登录，使用 ${account.email} 登录…`);
  await performLogin(page, account);

  const loggedIn = !(await isLoginPage(page));
  if (!loggedIn) return false;

  const returnTo = options.returnTo ?? options.intendedPath;
  if (returnTo) {
    const targetPath = pathnameOf(returnTo);
    const currentPath = pathnameOf(page.url());
    if (targetPath && !targetPath.includes('/login') && !currentPath.includes(targetPath)) {
      await page.goto(returnTo, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(1000);
    }
  }

  return true;
};

/** @deprecated use ensureLoggedIn */
export const maybeAutoLogin = async (
  page: Page,
  scenario: Scenario,
  envName: string,
  intendedPath?: string
): Promise<boolean> =>
  ensureLoggedIn(page, {
    envName,
    scenario,
    intendedPath,
  });
