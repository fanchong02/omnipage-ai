import type { Page } from '@playwright/test';
import { fillField, fillInputLocator, waitForClickable } from '../auth/form-fields.js';
import { dismissKnownOverlays } from './overlay.js';
import type { ExploreElementInfo, ExploreHistoryEntry, ExplorePlan } from './explore-planner.js';
import type { DetectedInteractive, InteractivesAnalysis } from './interactive-analyzer.js';

export type FilterField = {
  name: string;
  kind: 'input' | 'dropdown';
  testValue?: string;
};

export type FilterPanel = {
  fields: FilterField[];
  queryButton: string;
  resetButton?: string;
};

export type ContentSnapshot = {
  rowCount: number;
  emptyVisible: boolean;
  sampleTexts: string[];
  signature: string;
};

const QUERY_BUTTON_PATTERN = /查\s*询|搜索|search|筛选|filter|apply|确定/i;
const RESET_BUTTON_PATTERN = /重\s*置|清空|clear|reset/i;
const FILTER_FIELD_PATTERN =
  /任务|名称|状态|类型|关键词|keyword|search|筛选|filter|日期|date|status|category|编号|id|用户|部门|渠道|来源|标签|tag/i;
const NON_FILTER_INPUT_PATTERN = /email|password|邮箱|密码|账号|用户名|login|sign/i;

const TABLE_ROW_SELECTORS = [
  '.ant-table-tbody tr.ant-table-row',
  '.ant-table-tbody tr',
  '.el-table__body-wrapper tbody tr',
  'table tbody tr',
  '[role="row"]:not([role="columnheader"])',
  '.list-item',
  '[class*="table"] [class*="row"]',
];

export const captureContentSnapshot = async (page: Page): Promise<ContentSnapshot> => {
  const snapshot = await page.evaluate(selectors => {
    const emptyPatterns = [/暂无数据/i, /no data/i, /empty/i, /没有找到/i, /无结果/i, /0\s*条/];
    const bodyText = document.body.innerText ?? '';
    const emptyVisible = emptyPatterns.some(p => p.test(bodyText));

    let rows: Element[] = [];
    for (const selector of selectors) {
      const found = [...document.querySelectorAll(selector)].filter(el => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      if (found.length > rows.length) rows = found;
    }

    const sampleTexts = rows
      .slice(0, 5)
      .map(row => (row.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 80))
      .filter(Boolean);

    return {
      rowCount: rows.length,
      emptyVisible,
      sampleTexts,
    };
  }, TABLE_ROW_SELECTORS);

  const signature = `${snapshot.rowCount}|${snapshot.emptyVisible}|${snapshot.sampleTexts.join('||')}`;
  return { ...snapshot, signature };
};

const isFilterInputLabel = (label: string) => {
  if (NON_FILTER_INPUT_PATTERN.test(label)) return false;
  if (FILTER_FIELD_PATTERN.test(label)) return true;
  return /请输入|please enter|input|选择|select|picker/i.test(label);
};

const findButtonLabel = (
  interactives: DetectedInteractive[],
  pattern: RegExp
): string | undefined => {
  const match = interactives.find(
    i => i.kind === 'button' && !i.disabled && pattern.test(i.label.trim())
  );
  return match?.label;
};

/** 识别页面筛选区：存在「查询/搜索」按钮 + 至少一个筛选项 */
export const detectFilterPanel = (
  elements: ExploreElementInfo[],
  interactives?: InteractivesAnalysis
): FilterPanel | null => {
  const items = interactives?.interactives ?? [];
  const queryButton = findButtonLabel(items, QUERY_BUTTON_PATTERN);
  if (!queryButton) return null;

  const resetButton = findButtonLabel(items, RESET_BUTTON_PATTERN);

  const fieldCandidates = items.filter(item => {
    if (item.disabled || item.suggestedAction === 'skip') return false;
    if (item.kind !== 'input' && item.kind !== 'dropdown') return false;
    if (NON_FILTER_INPUT_PATTERN.test(item.label)) return false;
    if (item.location && /筛选|搜索|filter|search|toolbar|工具栏|表单/i.test(item.location)) {
      return true;
    }
    return isFilterInputLabel(item.label);
  });

  if (fieldCandidates.length === 0) {
    const domFields = elements
      .filter(el => !el.disabled && (el.tag === 'input' || el.role === 'combobox' || el.tag === 'select'))
      .filter(el => !NON_FILTER_INPUT_PATTERN.test(el.name))
      .filter(el => isFilterInputLabel(el.name) || Boolean(queryButton))
      .map(el => ({
        name: el.name,
        kind: (el.role === 'combobox' || el.tag === 'select' ? 'dropdown' : 'input') as
          | 'input'
          | 'dropdown',
        testValue: buildFilterTestValue(
          el.name,
          el.role === 'combobox' || el.tag === 'select' ? 'dropdown' : 'input'
        ),
      }));
    if (domFields.length === 0) return null;
    return { fields: domFields, queryButton, resetButton };
  }

  const fields: FilterField[] = fieldCandidates.map(item => ({
    name: item.label,
    kind: item.kind === 'dropdown' ? 'dropdown' : 'input',
    testValue: buildFilterTestValue(item.label, item.kind),
  }));

  return { fields, queryButton, resetButton };
};

export const buildFilterTestValue = (fieldName: string, kind: FilterField['kind']) => {
  if (kind === 'dropdown') return '';
  if (/日期|date|time/i.test(fieldName)) return '2024-01-01';
  if (/状态|status/i.test(fieldName)) return '进行';
  if (/编号|id/i.test(fieldName)) return '1';
  if (/名称|name|任务|title|keyword|关键词/i.test(fieldName)) return '测';
  return '测';
};

const pickFilterValueFromSnapshot = (snapshot: ContentSnapshot, fieldName: string, kind: FilterField['kind']) => {
  if (kind === 'dropdown') return '';
  if (snapshot.sampleTexts.length === 0) return buildFilterTestValue(fieldName, kind);

  const rowText = snapshot.sampleTexts[0] ?? '';
  const tokens = rowText.split(/[\s|/\-—,，、]+/).filter(t => t.length >= 1 && t.length <= 20);
  const match = tokens.find(t => !/^\d+$/.test(t)) ?? tokens[0];
  return (match ?? buildFilterTestValue(fieldName, kind)).slice(0, 8);
};

const filterTestFingerprint = (fieldName: string) => `filterTest:${fieldName.toLowerCase()}`;

export const getTestedFilterFields = (history: ExploreHistoryEntry[]): Set<string> => {
  const tested = new Set<string>();
  for (const entry of history) {
    if (entry.plan.type !== 'filterTest' || !entry.success) continue;
    tested.add(entry.plan.filterField.toLowerCase());
  }
  return tested;
};

export const planNextFilterTest = (input: {
  elements: ExploreElementInfo[];
  interactives?: InteractivesAnalysis;
  history: ExploreHistoryEntry[];
}): ExplorePlan | null => {
  const panel = detectFilterPanel(input.elements, input.interactives);
  if (!panel || panel.fields.length === 0) return null;

  const tested = getTestedFilterFields(input.history);
  const nextField = panel.fields.find(f => !tested.has(f.name.toLowerCase()));
  if (!nextField) return null;

  const testValue =
    nextField.testValue ?? buildFilterTestValue(nextField.name, nextField.kind);

  return {
    type: 'filterTest',
    filterField: nextField.name,
    filterKind: nextField.kind,
    filterValue: testValue,
    queryButton: panel.queryButton,
    resetButton: panel.resetButton,
    reasoning: `单独测试筛选项「${nextField.name}」：重置 → 填写 → 查询 → 验证结果`,
    testIntent: `筛选-${nextField.name}-单独测试`,
  };
};

const clickByLabel = async (page: Page, label: string) => {
  const locator = page
    .getByRole('button', { name: label, exact: false })
    .or(page.getByText(label, { exact: false }))
    .first();
  await waitForClickable(locator);
  await locator.click({ timeout: 10_000 });
};

const fillFilterInput = async (page: Page, name: string, value: string) => {
  const byPlaceholder = page.getByPlaceholder(name, { exact: false });
  if (await byPlaceholder.first().isVisible().catch(() => false)) {
    await fillInputLocator(byPlaceholder.first(), value);
    return;
  }
  await fillField(page, name, value, { submit: false });
};

const selectDropdownOption = async (page: Page, name: string) => {
  const trigger = page
    .getByRole('combobox', { name, exact: false })
    .or(page.getByText(name, { exact: false }))
    .or(page.locator('.ant-select').filter({ hasText: name }))
    .first();

  await waitForClickable(trigger);
  await trigger.click({ timeout: 10_000 });
  await page.waitForTimeout(400);

  const option = page
    .locator('.ant-select-item-option:not(.ant-select-item-option-disabled)')
    .or(page.locator('[role="option"]:not([aria-disabled="true"])'))
    .or(page.locator('.el-select-dropdown__item:not(.is-disabled)'))
    .first();

  if (await option.isVisible({ timeout: 3000 }).catch(() => false)) {
    await option.click({ timeout: 5000 });
    return;
  }

  await page.keyboard.press('ArrowDown').catch(() => undefined);
  await page.keyboard.press('Enter').catch(() => undefined);
};

const waitForFilterResponse = async (page: Page) => {
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);
  await page.waitForTimeout(800);
};

export type FilterTestResult = {
  success: boolean;
  before: ContentSnapshot;
  after: ContentSnapshot;
  message: string;
};

export const compareFilterSnapshots = (
  before: ContentSnapshot,
  after: ContentSnapshot,
  fieldName: string
): FilterTestResult => {
  const changed = before.signature !== after.signature;

  if (changed) {
    if (after.emptyVisible && after.rowCount === 0) {
      return {
        success: true,
        before,
        after,
        message: `筛选「${fieldName}」生效，当前无匹配数据（空状态）`,
      };
    }
    return {
      success: true,
      before,
      after,
      message: `筛选「${fieldName}」生效，结果 ${before.rowCount} 条 → ${after.rowCount} 条`,
    };
  }

  if (after.rowCount > 0) {
    return {
      success: true,
      before,
      after,
      message: `筛选「${fieldName}」已查询，列表仍为 ${after.rowCount} 条（结果未变化，可能筛值无区分度）`,
    };
  }

  return {
    success: false,
    before,
    after,
    message: `筛选「${fieldName}」后页面无可见结果，且前后状态一致，需人工确认`,
  };
};

export const executeFilterTest = async (
  page: Page,
  plan: Extract<ExplorePlan, { type: 'filterTest' }>
): Promise<FilterTestResult> => {
  await dismissKnownOverlays(page);

  if (plan.resetButton) {
    await clickByLabel(page, plan.resetButton).catch(() => undefined);
    await page.waitForTimeout(500);
  }

  const before = await captureContentSnapshot(page);
  const filterValue =
    plan.filterValue ||
    pickFilterValueFromSnapshot(before, plan.filterField, plan.filterKind);

  try {
    if (plan.filterKind === 'dropdown') {
      await selectDropdownOption(page, plan.filterField);
    } else {
      await fillFilterInput(page, plan.filterField, filterValue);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      before,
      after: before,
      message: `筛选「${plan.filterField}」填写失败 — ${message}`,
    };
  }

  await page.waitForTimeout(300);
  await clickByLabel(page, plan.queryButton);
  await waitForFilterResponse(page);

  const after = await captureContentSnapshot(page);
  return compareFilterSnapshots(before, after, plan.filterField);
};

export const fingerprintFilterPlan = (plan: Extract<ExplorePlan, { type: 'filterTest' }>) =>
  filterTestFingerprint(plan.filterField);
