import type { Page } from '@playwright/test';
import type { AgentAction, AgentHistoryEntry } from '../types.js';
import { ensureLoggedIn } from '../auth/auto-login.js';
import { captureAccessibilitySnapshot } from './snapshot.js';
import { planNextAction } from './planner.js';
import { fillInputLocator } from '../auth/form-fields.js';
import { dismissKnownOverlays } from './overlay.js';

export const executeAgentAction = async (
  page: Page,
  action: AgentAction
): Promise<void> => {
  switch (action.type) {
    case 'click': {
      await dismissKnownOverlays(page);
      const locator = action.role
        ? page.getByRole(action.role as 'button', { name: action.name, exact: false })
        : page.getByText(action.name, { exact: false });
      await locator.first().click({ timeout: 10_000 });
      break;
    }
    case 'fill': {
      const locator = action.role
        ? page.getByRole(action.role as 'textbox', { name: action.name, exact: false })
        : page.getByPlaceholder(action.name);
      await fillInputLocator(locator, action.value);
      break;
    }
    case 'scroll':
      if (action.direction === 'bottom') {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      } else {
        await page.evaluate(() => window.scrollTo(0, 0));
      }
      break;
    case 'wait':
      await page.waitForTimeout(action.ms);
      break;
    case 'assertVisible':
      await page.getByText(action.name, { exact: false }).first().waitFor({
        state: 'visible',
        timeout: 10_000,
      });
      break;
    case 'done':
      break;
    default:
      throw new Error(`Unknown agent action: ${(action as AgentAction).type}`);
  }
};

export const runAgentTask = async (
  page: Page,
  task: string,
  options: {
    maxSteps?: number;
    envName?: string;
    account?: string;
    authDisabled?: boolean;
    onStep?: (step: number, action: AgentAction) => void;
  } = {}
): Promise<{ history: AgentHistoryEntry[]; summary: string }> => {
  const maxSteps = options.maxSteps ?? 12;
  const history: AgentHistoryEntry[] = [];

  for (let step = 0; step < maxSteps; step += 1) {
    if (options.envName) {
      await ensureLoggedIn(page, {
        envName: options.envName,
        account: options.account,
        disabled: options.authDisabled,
      });
    }

    const snapshot = await captureAccessibilitySnapshot(page);
    const action = await planNextAction({
      task,
      snapshot,
      url: page.url(),
      history,
    });

    options.onStep?.(step, action);

    if (action.type === 'done') {
      return { history, summary: action.summary ?? 'Agent task completed' };
    }

    try {
      await executeAgentAction(page, action);
      history.push({ action, success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      history.push({ action, success: false, error: message });
      throw new Error(`Agent step ${step + 1} failed: ${message}`);
    }

    await page.waitForTimeout(300);
  }

  return { history, summary: `Stopped after ${maxSteps} steps` };
};
