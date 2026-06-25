import type { Page } from '@playwright/test';
import type { Account } from '../credentials.js';
import { dismissKnownOverlays, dismissBlockingModals } from '../agent/overlay.js';
import {
  fillField,
  fillLoginAccount,
  fillLoginPassword,
  waitForClickable,
} from './form-fields.js';

export type LoginOptions = {
  loginUrl?: string;
};

/** Close modals that block the login form (e.g. post-subscription "Create account") */
const hasSubscriptionSignupModal = async (page: Page) =>
  page.getByText('One more step', { exact: false }).first().isVisible().catch(() => false);

const clearPreLoginClientState = async (page: Page) => {
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (
        /onboarding|subscription|checkout|order|payment|signup|register/i.test(key) &&
        !key.includes('auth.store')
      ) {
        localStorage.removeItem(key);
      }
    }
  });
};

const dismissLoginBlockingModals = async (page: Page) => {
  if (!(await hasSubscriptionSignupModal(page))) return;

  await page.keyboard.press('Escape').catch(() => undefined);
  await page.waitForTimeout(300);

  if (!(await hasSubscriptionSignupModal(page))) return;

  const back = page.locator('button, a').first();
  await back.click({ timeout: 3000 }).catch(() => undefined);
  await page.waitForTimeout(400);

  if (!(await hasSubscriptionSignupModal(page))) return;

  await clearPreLoginClientState(page);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(1000);
};

const findSubmitButton = (page: Page, label?: string) => {
  if (label) {
    return page.getByRole('button', { name: label, exact: false });
  }
  return page.getByRole('button', {
    name: /sign in|log in|login|continue|登录|登入|确定|提交/i,
  });
};

export const performLogin = async (
  page: Page,
  account: Account,
  options: LoginOptions = {}
): Promise<void> => {
  if (!account.password) {
    throw new Error(
      `Account "${account.name}" has no password. Set it in config/accounts.yaml`
    );
  }

  const loginUrl = options.loginUrl ?? account.loginUrl;
  if (loginUrl) {
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(1000);
  }

  await dismissKnownOverlays(page);
  await dismissLoginBlockingModals(page);
  await dismissBlockingModals(page);

  const accountFieldLabel = account.fields?.email;
  const passwordFieldLabel = account.fields?.password;
  const submitLabel = account.fields?.submit;

  const fillAndSubmit = async () => {
    await dismissBlockingModals(page);
    if (accountFieldLabel) {
      await fillField(page, accountFieldLabel, account.email);
    } else {
      await fillLoginAccount(page, account.email);
    }
    await dismissBlockingModals(page);
    if (passwordFieldLabel) {
      await fillField(page, passwordFieldLabel, account.password!);
    } else {
      await fillLoginPassword(page, account.password!);
    }

    await dismissLoginBlockingModals(page);
    await dismissKnownOverlays(page);

    const submitButton = findSubmitButton(page, submitLabel).first();
    await submitButton.waitFor({ state: 'visible', timeout: 10_000 });
    await waitForClickable(submitButton);
    await submitButton.click({ timeout: 10_000 });
  };

  await fillAndSubmit();
  await page.waitForLoadState('domcontentloaded').catch(() => undefined);
  await page.waitForTimeout(1500);
};
