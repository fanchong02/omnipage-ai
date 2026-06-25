import type { Page } from '@playwright/test';
import type { ExplorePlan } from './explore-planner.js';

const pathnameOf = (url: string) => {
  try {
    return new URL(url).pathname + new URL(url).search;
  } catch {
    return url;
  }
};

export const detectPageFeedback = async (page: Page): Promise<string[]> => {
  const messages: string[] = [];

  const selectors = [
    '[role="alert"]',
    '[role="status"]',
    '[class*="toast" i]',
    '[class*="Toast"]',
    '[class*="snackbar" i]',
    '[class*="Snackbar"]',
    '[class*="error-message" i]',
    '[class*="success-message" i]',
    '[class*="notification" i]',
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = Math.min(await locator.count().catch(() => 0), 4);
    for (let i = 0; i < count; i += 1) {
      const text = await locator
        .nth(i)
        .innerText()
        .catch(() => '');
      const trimmed = text.trim().replace(/\s+/g, ' ').slice(0, 160);
      if (trimmed.length >= 2) messages.push(trimmed);
    }
  }

  return [...new Set(messages)].slice(0, 4);
};

export const buildActionOutcome = (params: {
  action: 'click' | 'fill' | 'toggle' | 'scroll' | 'skip' | 'done' | 'filterTest';
  plan?: ExplorePlan;
  element?: { name: string };
  success: boolean;
  reason?: string;
  urlBefore: string;
  urlAfter: string;
  feedback: string[];
}): string => {
  const { action, plan, element, success, reason, urlBefore, urlAfter, feedback } = params;
  const urlChanged = urlBefore !== urlAfter;
  const feedbackText = feedback.length ? `页面提示：${feedback.join('；')}` : '';

  if (action === 'skip') {
    return reason ? `已跳过 — ${reason}` : '已跳过';
  }
  if (action === 'done') {
    return plan?.type === 'done' ? `探索完成 — ${plan.summary}` : '探索完成';
  }

  if (!success) {
    return reason ? `操作失败 — ${reason}` : '操作失败';
  }

  const targetName =
    plan?.type === 'click' || plan?.type === 'fill'
      ? plan.name
      : element?.name;

  if (action === 'scroll') {
    const dir = plan?.type === 'scroll' && plan.direction === 'bottom' ? '底部' : '顶部';
    return `滚动至页面${dir}成功`;
  }

  if (action === 'fill') {
    const submitted = plan?.type === 'fill' && plan.submit;
    const base = submitted
      ? `填写「${targetName ?? '输入框'}」并提交`
      : `填写「${targetName ?? '输入框'}」`;
    if (urlChanged) {
      return `${base}成功，页面跳转至 ${pathnameOf(urlAfter)}`;
    }
    if (feedbackText) return `${base}成功，${feedbackText}`;
    return submitted ? `${base}成功` : `${base}成功，表单已更新`;
  }

  if (action === 'toggle') {
    return `切换「${targetName ?? '控件'}」成功`;
  }

  if (action === 'filterTest') {
    const field =
      plan?.type === 'filterTest'
        ? plan.filterField
        : targetName;
    if (!success) {
      return reason ?? `筛选「${field ?? '筛选项'}」验证未通过`;
    }
    return reason ?? `筛选「${field ?? '筛选项'}」验证通过`;
  }

  if (action === 'click') {
    const base = `点击「${targetName ?? '元素'}」`;
    if (urlChanged) {
      return `${base}成功，页面跳转至 ${pathnameOf(urlAfter)}`;
    }
    if (feedbackText) return `${base}成功，${feedbackText}`;
    return `${base}成功，页面无跳转`;
  }

  return success ? '操作成功' : '操作失败';
};

export const enrichActionResult = async (
  page: Page,
  result: {
    action: 'click' | 'fill' | 'toggle' | 'scroll' | 'skip' | 'done' | 'filterTest';
    plan?: ExplorePlan;
    element?: { name: string };
    success: boolean;
    reason?: string;
    urlBefore: string;
  },
  screenshotAfter?: string
) => {
  await page.waitForTimeout(400);
  const urlAfter = page.url();
  const feedback = await detectPageFeedback(page);
  const outcome = buildActionOutcome({
    ...result,
    urlAfter,
    feedback,
  });

  return {
    urlAfter,
    feedback,
    outcome,
    screenshotAfter,
  };
};
