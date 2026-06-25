/** 标题栏/顶栏返回控件 — 探索时不主动点击，二级页返回由 restorePage 处理 */

export const HEADER_BACK_LABEL_PATTERNS = [
  /^\s*back\s*$/i,
  /^返回$/,
  /go\s*back/i,
  /back\s*to/i,
  /^←/,
  /chevron\s*left/i,
  /arrow\s*back/i,
  /navigate\s*back/i,
  /^previous$/i,
  /^上一页$/,
];

export const isHeaderBackLabel = (label: string): boolean =>
  HEADER_BACK_LABEL_PATTERNS.some(p => p.test(label.trim()));

/** 探索阶段是否应跳过该控件（不点击 UI 返回） */
export const shouldSkipHeaderBackTest = (label: string): boolean => isHeaderBackLabel(label);

export const isHeaderBackExplorePlan = (plan: {
  type: string;
  name?: string;
}): boolean => plan.type === 'click' && Boolean(plan.name && shouldSkipHeaderBackTest(plan.name));

export const headerBackSkipReason =
  '标题栏返回按钮：探索时不测试；若进入二级页将由框架自动返回起始页';

export const chromeSkipReason = '聚焦内容区，跳过顶栏/底栏控件';
