import type { Page } from '@playwright/test';

export const captureAccessibilitySnapshot = async (page: Page): Promise<string> => {
  try {
    const snapshot = await page.locator('body').ariaSnapshot();
    if (typeof snapshot === 'string' && snapshot.trim()) {
      return snapshot;
    }
  } catch {
    // fall through
  }

  // Fallback: simplified interactive element list
  return page.evaluate(() => {
    const lines: string[] = [];
    const nodes = document.querySelectorAll(
      'button, a, input, textarea, select, [role="button"], [role="link"]'
    );
    nodes.forEach((el, index) => {
      const role =
        el.getAttribute('role') ||
        el.tagName.toLowerCase();
      const name =
        el.getAttribute('aria-label') ||
        (el as HTMLElement).innerText?.trim().slice(0, 80) ||
        el.getAttribute('placeholder') ||
        '';
      if (name) {
        lines.push(`- ${role} "${name}" #${index}`);
      }
    });
    return lines.join('\n') || '(empty page)';
  });
};

export const truncateSnapshot = (snapshot: string, maxLines = 120): string => {
  const lines = snapshot.split('\n');
  if (lines.length <= maxLines) return snapshot;
  return [...lines.slice(0, maxLines), `... (${lines.length - maxLines} more lines)`].join('\n');
};
