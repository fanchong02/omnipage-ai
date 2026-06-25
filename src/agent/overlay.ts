import type { Page } from '@playwright/test';

const OVERLAY_DISMISS_LABELS = [
  'Claim',
  'Claim my discount',
  'Got it',
  'Close',
  'No thanks',
  'Continue',
  'Not now',
  'Maybe later',
  'Skip',
];

const hasVisibleModal = async (page: Page) =>
  page.locator('[class*="modalOverlay"], [class*="ModalOverlay"]').first().isVisible().catch(() => false);

/** Dismiss modals/masks that block clicks (login form, selling pages, etc.) */
export const dismissBlockingModals = async (page: Page) => {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (!(await hasVisibleModal(page))) return;

    await page.keyboard.press('Escape').catch(() => undefined);
    await page.waitForTimeout(250);

    for (const label of OVERLAY_DISMISS_LABELS) {
      const button = page.getByRole('button', { name: label, exact: false });
      if ((await button.count()) === 0) continue;
      const first = button.first();
      if (!(await first.isVisible().catch(() => false))) continue;
      await first.click({ timeout: 2000 }).catch(() => undefined);
      await page.waitForTimeout(300);
    }

    const closeIcon = page.locator('[aria-label="Close"], [aria-label="close"], button[class*="close"]').first();
    if (await closeIcon.isVisible().catch(() => false)) {
      await closeIcon.click({ timeout: 2000 }).catch(() => undefined);
      await page.waitForTimeout(300);
    }

    const mask = page.locator('[class*="modalOverlay"], [class*="ModalOverlay"]').first();
    if (await mask.isVisible().catch(() => false)) {
      await mask.click({ position: { x: 8, y: 8 }, timeout: 2000 }).catch(() => undefined);
      await page.waitForTimeout(300);
    }

    if (!(await hasVisibleModal(page))) return;
  }
};

/** Dismiss common promotional overlays that block clicks on selling pages */
export const dismissKnownOverlays = async (page: Page) => {
  await dismissBlockingModals(page);

  for (const label of OVERLAY_DISMISS_LABELS) {
    const button = page.getByRole('button', { name: label, exact: false });
    if ((await button.count()) === 0) continue;
    const first = button.first();
    if (!(await first.isVisible().catch(() => false))) continue;
    await first.click({ timeout: 3000 }).catch(() => undefined);
    await page.waitForTimeout(400);
  }
};
