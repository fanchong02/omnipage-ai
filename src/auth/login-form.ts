import type { Locator, Page } from '@playwright/test';

const VISIBLE_INPUT = async (locator: Locator) =>
  locator.isVisible().catch(() => false);

const isSkippableInputType = (type: string | null) =>
  type === 'password' ||
  type === 'hidden' ||
  type === 'checkbox' ||
  type === 'radio' ||
  type === 'file' ||
  type === 'submit' ||
  type === 'button';

/** 页面上是否有密码框（常见于登录表单） */
export const isLikelyLoginForm = async (page: Page): Promise<boolean> => {
  const password = page.locator('input[type="password"]').first();
  return VISIBLE_INPUT(password);
};

const ACCOUNT_INPUT_SELECTORS = [
  'input[type="email"]',
  'input[name="email"]',
  'input[name="username"]',
  'input[name="account"]',
  'input[name="user"]',
  'input[name="login"]',
  'input[name="loginName"]',
  'input[autocomplete="email"]',
  'input[autocomplete="username"]',
  'input[id*="email" i]',
  'input[id*="account" i]',
  'input[id*="user" i]',
  'input[id*="login" i]',
  'input[placeholder*="账号" i]',
  'input[placeholder*="用户名" i]',
  'input[placeholder*="邮箱" i]',
  'input[placeholder*="account" i]',
  'input[placeholder*="user" i]',
];

export const findVisibleLoginAccountInput = async (page: Page): Promise<Locator | null> => {
  for (const selector of ACCOUNT_INPUT_SELECTORS) {
    const locator = page.locator(selector).first();
    if (await VISIBLE_INPUT(locator)) return locator;
  }

  const labeled = page
    .getByLabel(/email|邮箱|account|username|user\s*name|账号|用户名|login|手机/i)
    .first();
  if (await VISIBLE_INPUT(labeled)) return labeled;

  const placeholder = page
    .getByPlaceholder(/email|邮箱|account|username|账号|用户名|login|手机|@/i)
    .first();
  if (await VISIBLE_INPUT(placeholder)) return placeholder;

  const inputs = page.locator('input');
  const count = await inputs.count();
  for (let i = 0; i < count; i += 1) {
    const locator = inputs.nth(i);
    if (!(await VISIBLE_INPUT(locator))) continue;
    const type = await locator.getAttribute('type').catch(() => 'text');
    if (isSkippableInputType(type)) continue;
    return locator;
  }

  return null;
};

export const findVisibleLoginPasswordInput = async (page: Page): Promise<Locator | null> => {
  const selectors = [
    'input[type="password"]',
    'input[name="password"]',
    'input[autocomplete="current-password"]',
    'input[placeholder*="密码" i]',
    'input[placeholder*="password" i]',
  ];
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await VISIBLE_INPUT(locator)) return locator;
  }

  const labeled = page.getByLabel(/password|密码/i).first();
  if (await VISIBLE_INPUT(labeled)) return labeled;

  return null;
};

export const resolveLoginAccountLocator = async (page: Page): Promise<Locator> => {
  const input = await findVisibleLoginAccountInput(page);
  if (!input) {
    throw new Error('未找到登录账号输入框（支持：账号 / 用户名 / 邮箱）');
  }
  return input;
};

export const resolveLoginPasswordLocator = async (page: Page): Promise<Locator> => {
  const input = await findVisibleLoginPasswordInput(page);
  if (!input) {
    throw new Error('未找到登录密码输入框');
  }
  return input;
};
