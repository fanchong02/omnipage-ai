import type { Page } from '@playwright/test';
import { ensureLoggedIn, isAuthTestPath, type EnsureLoggedInOptions } from './auto-login.js';

export const gotoWithAuth = async (
  page: Page,
  url: string,
  options: EnsureLoggedInOptions & { waitMs?: number } = { envName: 'default' }
): Promise<void> => {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(options.waitMs ?? 1500);

  if (isAuthTestPath(url)) return;

  await ensureLoggedIn(page, {
    ...options,
    intendedPath: url,
    returnTo: url,
  });
};
