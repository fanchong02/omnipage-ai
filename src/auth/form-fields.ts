import type { Locator, Page } from '@playwright/test';
import { dismissBlockingModals } from '../agent/overlay.js';
import {
  findVisibleLoginAccountInput,
  findVisibleLoginPasswordInput,
  isLikelyLoginForm,
  resolveLoginAccountLocator,
  resolveLoginPasswordLocator,
} from './login-form.js';

export type FillOptions = {
  submit?: boolean;
};

const SMART_VALUES: Array<{ pattern: RegExp; value: string }> = [
  { pattern: /email|邮箱|@/i, value: 'qa-auto@example.com' },
  { pattern: /password|密码/i, value: 'WrongPass123!' },
  { pattern: /phone|mobile|tel|手机/i, value: '13800138000' },
  { pattern: /name|username|姓名|称呼|call you/i, value: 'QA Auto' },
  { pattern: /search|搜索|chat|prompt|ask|message|question|反馈|feedback|reason|comment|textarea/i, value: 'E2E automated test input' },
  { pattern: /promo|code|coupon|优惠/i, value: 'E2E50' },
  { pattern: /url|link|website/i, value: 'https://example.com' },
];

export const resolveSmartFillValue = (selector: string, explicit?: string) => {
  if (explicit && explicit !== 'auto') return explicit;
  for (const rule of SMART_VALUES) {
    if (rule.pattern.test(selector)) return rule.value;
  }
  return 'E2E automated test input';
};

export const findTextbox = (page: Page, label: string) =>
  page
    .getByLabel(label, { exact: false })
    .or(page.getByPlaceholder(label, { exact: false }))
    .or(page.getByRole('textbox', { name: label, exact: false }));

export const resolveFillLocator = (page: Page, selector: string) => {
  const text = selector.startsWith('text=') ? selector.slice(5) : selector;

  if (/email/i.test(text)) {
    return findTextbox(page, text)
      .or(page.getByLabel(/email/i))
      .or(page.getByPlaceholder(/email|example@gmail|@/i))
      .or(page.locator('input[type="email"], input[name="email"], input[autocomplete="email"]'));
  }
  if (/password/i.test(text)) {
    return findTextbox(page, text)
      .or(page.getByLabel(/password/i))
      .or(page.getByPlaceholder(/password|enter your password/i))
      .or(
        page.locator(
          'input[type="password"], input[name="password"], input[autocomplete="current-password"]'
        )
      );
  }
  if (/ask anything|chat|prompt|message|search|feedback|reason|comment|textarea/i.test(text)) {
    return page
      .getByPlaceholder(/ask anything/i)
      .or(findTextbox(page, text))
      .or(page.getByPlaceholder(new RegExp(text, 'i')))
      .or(page.locator('textarea').filter({ hasText: '' }))
      .or(page.locator('textarea'))
      .or(page.locator('[contenteditable="true"]'));
  }
  return findTextbox(page, text)
    .or(page.getByPlaceholder(new RegExp(text, 'i')))
    .or(page.locator('textarea, input:not([type="hidden"]):not([type="file"])'));
};

const syncReactInputValue = async (input: Locator, value: string) => {
  await input.evaluate((el, val) => {
    const node = el as HTMLInputElement | HTMLTextAreaElement;
    const proto =
      node instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;

    if (setter) {
      setter.call(node, '');
      node.dispatchEvent(
        new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'deleteContentBackward' })
      );
      for (const char of val) {
        setter.call(node, node.value + char);
        node.dispatchEvent(
          new InputEvent('input', {
            bubbles: true,
            cancelable: true,
            data: char,
            inputType: 'insertText',
          })
        );
      }
    } else {
      node.value = val;
      node.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: val }));
    }

    node.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
};

const isLoginPage = (page: Page) => /\/login(?:[/?#]|$)/i.test(page.url());

const loginAccountInput = (page: Page) => findVisibleLoginAccountInput(page);

/** React 受控组件需要逐字符触发 input 事件，单纯 fill 不会更新表单状态 */
export const fillInputLocator = async (locator: Locator, value: string) => {
  const input = locator.first();
  const page = input.page();
  await input.waitFor({ state: 'visible', timeout: 10_000 });
  await input.scrollIntoViewIfNeeded().catch(() => undefined);

  let modalBlocks = await page
    .locator('[class*="modalOverlay"], [class*="ModalOverlay"]')
    .first()
    .isVisible()
    .catch(() => false);
  if (modalBlocks && isLoginPage(page)) {
    await dismissBlockingModals(page);
    modalBlocks = await page
      .locator('[class*="modalOverlay"], [class*="ModalOverlay"]')
      .first()
      .isVisible()
      .catch(() => false);
  }

  await input.click({ timeout: 5000, force: modalBlocks });

  const tagName = await input.evaluate(el => el.tagName.toLowerCase()).catch(() => 'input');
  const isTextarea = tagName === 'textarea';

  await input.fill('');
  await input.pressSequentially(value, { delay: isTextarea ? 45 : 40 });

  if (!isTextarea) {
    await syncReactInputValue(input, value);
  }

  let actual = await input.inputValue().catch(() => '');
  if (actual !== value) {
    await input.fill('');
    await input.pressSequentially(value, { delay: isTextarea ? 50 : 50 });
    if (!isTextarea) {
      await syncReactInputValue(input, value);
    } else {
      await syncReactInputValue(input, value);
    }
    actual = await input.inputValue().catch(() => '');
  }

  if (actual !== value) {
    throw new Error(`Failed to fill input, expected "${value}" but got "${actual}"`);
  }

  if (isTextarea) {
    const sendBtn = page.getByRole('button', { name: /send message/i }).first();
    if (await sendBtn.isVisible().catch(() => false)) {
      await waitForClickable(sendBtn, 12_000);
    }
  }

  await input.blur().catch(() => undefined);
  await page.waitForTimeout(isLoginPage(page) ? 350 : 150);
};

const SUBMIT_BUTTON_NAMES =
  /^(continue|submit|send|sign in|log in|login|next step|next|apply|save|confirm|get my plan|start the quiz|send message|send reset|unlock|run in ai tool|copy)$/i;

const isChatSelector = (selector?: string) =>
  Boolean(selector && /ask anything|chat|prompt|message/i.test(selector));

const waitForAiToolsModels = async (page: Page) => {
  await page
    .waitForResponse(
      resp => resp.url().includes('/ml/aiTools/models') && resp.status() === 200,
      { timeout: 20_000 }
    )
    .catch(async () => {
      await page.waitForTimeout(3000);
    });
};

export const submitFilledField = async (page: Page, selector?: string) => {
  if (isChatSelector(selector)) {
    const sendBtn = page.getByRole('button', { name: /send message/i }).first();
    if (await sendBtn.isVisible().catch(() => false)) {
      await waitForClickable(sendBtn, 15_000);
      await sendBtn.click({ timeout: 10_000 });
      await page.waitForTimeout(500);
      return;
    }
  }

  const submit = page.getByRole('button', { name: SUBMIT_BUTTON_NAMES }).first();
  if (await submit.isVisible().catch(() => false)) {
    await waitForClickable(submit, 12_000);
    await submit.click({ timeout: 10_000 });
    await page.waitForTimeout(500);
    return;
  }

  const locator = selector
    ? resolveFillLocator(page, selector)
    : page.locator('textarea, input').first();
  await locator.first().press('Enter').catch(() => undefined);
  await page.waitForTimeout(400);
};

export const fillLoginAccount = async (page: Page, accountValue: string) => {
  const locator = await resolveLoginAccountLocator(page);
  await fillInputLocator(locator, accountValue);
};

export const fillLoginPassword = async (page: Page, password: string) => {
  const locator = await resolveLoginPasswordLocator(page);
  await fillInputLocator(locator, password);
};

export const fillField = async (
  page: Page,
  selector: string,
  value: string,
  options: FillOptions = {}
) => {
  const resolvedValue = resolveSmartFillValue(selector, value);

  if (await isLikelyLoginForm(page)) {
    if (/^email$/i.test(selector.trim()) || /账号|用户名|account|username|邮箱/i.test(selector)) {
      await fillLoginAccount(page, resolvedValue);
      if (options.submit) await submitFilledField(page, selector);
      return;
    }
    if (/^password$/i.test(selector.trim()) || /密码/i.test(selector)) {
      const accountInput = await loginAccountInput(page);
      const savedAccount = accountInput ? await accountInput.inputValue().catch(() => '') : '';
      await fillLoginPassword(page, resolvedValue);
      if (savedAccount && accountInput) {
        const currentAccount = await accountInput.inputValue().catch(() => '');
        if (!currentAccount) {
          await fillInputLocator(accountInput, savedAccount);
        }
      }
      if (options.submit) await submitFilledField(page, selector);
      return;
    }
  }

  const locator = resolveFillLocator(page, selector);

  if (/password/i.test(selector) && isLoginPage(page)) {
    const accountInput = await loginAccountInput(page);
    const savedAccount = accountInput ? await accountInput.inputValue().catch(() => '') : '';
    await fillInputLocator(locator, resolvedValue);

    if (savedAccount && accountInput) {
      const currentAccount = await accountInput.inputValue().catch(() => '');
      if (!currentAccount) {
        await fillInputLocator(accountInput, savedAccount);
      }
    }
    if (options.submit) await submitFilledField(page, selector);
    return;
  }

  if (isChatSelector(selector) && /\/ai-tools/i.test(page.url())) {
    await waitForAiToolsModels(page);
  }

  await fillInputLocator(locator, resolvedValue);

  if (isLoginPage(page) && /email|account|username|账号|用户名|邮箱|password/i.test(selector)) {
    await page.waitForTimeout(200);
  }

  if (options.submit) {
    await submitFilledField(page, selector);
  }
};

export const waitForClickable = async (locator: Locator, timeoutMs = 15_000) => {
  const target = locator.first();
  await target.waitFor({ state: 'visible', timeout: timeoutMs });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await target.isEnabled().catch(() => false)) return;
    await target.page().waitForTimeout(150);
  }
  throw new Error('Element stayed disabled');
};

export const uploadFile = async (
  page: Page,
  filePath: string,
  selector = 'input[type="file"]'
) => {
  const input = page.locator(selector).first();
  await input.waitFor({ state: 'attached', timeout: 10_000 });
  await input.setInputFiles(filePath);
  await page.waitForTimeout(1500);
};
