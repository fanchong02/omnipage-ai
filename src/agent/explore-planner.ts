import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { chatCompletion, getLlmConfig } from './llm-client.js';
import { truncateSnapshot } from './snapshot.js';
import {
  formatInteractivesDetail,
  type InteractivesAnalysis,
} from './interactive-analyzer.js';
import {
  headerBackSkipReason,
  isHeaderBackExplorePlan,
  shouldSkipHeaderBackTest,
} from './explore-navigation.js';
import { planNextFilterTest, fingerprintFilterPlan, detectFilterPanel, getTestedFilterFields } from './filter-explore.js';

export type ExploreElementInfo = {
  id?: string;
  role: string;
  name: string;
  tag: string;
  inputType?: string;
  disabled: boolean;
};

export const ExplorePlanSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('click'),
    name: z.string(),
    role: z.string().optional(),
    reasoning: z.string(),
    testIntent: z.string(),
  }),
  z.object({
    type: z.literal('fill'),
    name: z.string(),
    value: z.string(),
    submit: z.boolean().optional(),
    reasoning: z.string(),
    testIntent: z.string(),
  }),
  z.object({
    type: z.literal('scroll'),
    direction: z.enum(['bottom', 'top']),
    reasoning: z.string(),
    testIntent: z.string(),
  }),
  z.object({
    type: z.literal('filterTest'),
    filterField: z.string(),
    filterKind: z.enum(['input', 'dropdown']),
    filterValue: z.string().optional(),
    queryButton: z.string(),
    resetButton: z.string().optional(),
    reasoning: z.string(),
    testIntent: z.string(),
  }),
  z.object({
    type: z.literal('skip'),
    reason: z.string(),
    testIntent: z.string().optional(),
  }),
  z.object({
    type: z.literal('done'),
    summary: z.string(),
    reasoning: z.string().optional(),
  }),
]);

export type ExplorePlan = z.infer<typeof ExplorePlanSchema>;

export type ExploreHistoryEntry = {
  plan: ExplorePlan;
  fingerprint: string;
  success: boolean;
  error?: string;
  screenshot?: string;
};

const DANGEROUS_PATTERNS = [
  /pay\b/i,
  /purchase/i,
  /buy now/i,
  /checkout/i,
  /subscribe/i,
  /confirm order/i,
  /delete/i,
  /remove account/i,
  /logout/i,
  /log out/i,
  /sign out/i,
  /unsubscribe/i,
  /submit payment/i,
  /place order/i,
];

const screenshotToDataUrl = (screenshotPath: string) => {
  if (!existsSync(screenshotPath)) throw new Error(`Screenshot not found: ${screenshotPath}`);
  return `data:image/png;base64,${readFileSync(screenshotPath).toString('base64')}`;
};

const normalizeIntent = (intent: string) => intent.toLowerCase().replace(/\s+/g, ' ').trim();

export const fingerprintExplorePlan = (plan: ExplorePlan): string => {
  switch (plan.type) {
    case 'click':
      return `click:${plan.name.toLowerCase()}`;
    case 'fill':
      return `fill:${plan.name.toLowerCase()}:${plan.value.toLowerCase()}`;
    case 'scroll':
      return `scroll:${plan.direction}`;
    case 'filterTest':
      return fingerprintFilterPlan(plan);
    case 'skip':
      return `skip:${normalizeIntent(plan.testIntent ?? plan.reason)}`;
    case 'done':
      return 'done';
    default:
      return 'unknown';
  }
};

export const isDuplicateExplorePlan = (
  plan: ExplorePlan,
  history: ExploreHistoryEntry[]
): boolean => {
  if (plan.type === 'done') return false;

  const fp = fingerprintExplorePlan(plan);
  if (history.some(entry => {
    if (entry.fingerprint !== fp || entry.plan.type === 'skip') return false;
    if (plan.type === 'filterTest' && !entry.success) return false;
    return true;
  })) {
    return true;
  }

  if ('testIntent' in plan && plan.testIntent) {
    const intent = normalizeIntent(plan.testIntent);
    return history.some(
      entry =>
        'testIntent' in entry.plan &&
        entry.plan.testIntent &&
        normalizeIntent(entry.plan.testIntent) === intent &&
        entry.plan.type !== 'skip' &&
        entry.success
    );
  }

  return false;
};

export const isDangerousExplorePlan = (plan: ExplorePlan, safeMode: boolean) => {
  if (!safeMode || plan.type === 'skip' || plan.type === 'done' || plan.type === 'scroll') {
    return false;
  }
  const label = plan.type === 'click' || plan.type === 'fill' ? plan.name : '';
  return DANGEROUS_PATTERNS.some(p => p.test(label));
};

const formatElements = (elements: ExploreElementInfo[]) =>
  elements
    .slice(0, 35)
    .map(
      el =>
        `- [${el.role || el.tag}] "${el.name}"${el.disabled ? ' (disabled)' : ''}${el.inputType ? ` type=${el.inputType}` : ''}`
    )
    .join('\n');

const formatHistory = (history: ExploreHistoryEntry[]) =>
  history
    .slice(-8)
    .map(entry => {
      const plan = entry.plan;
      const status = entry.success ? 'ok' : 'fail';
      if (plan.type === 'skip') return `- skip: ${plan.reason}`;
      if (plan.type === 'done') return `- done: ${plan.summary}`;
      const intent = 'testIntent' in plan ? plan.testIntent : '';
      return `- ${plan.type} "${'name' in plan ? plan.name : plan.direction}" (${status}) intent: ${intent}`;
    })
    .join('\n');

const buildSystemPrompt = () => `你是移动端 H5/Web 启发式测试 Agent。根据**最新截图**、**可交互元素分析**和历史记录，决定**下一步**要测什么。

可交互类型包括：button（按钮）、link（链接/跳转）、tab（Tab 切换）、dropdown（下拉）、input/textarea（输入）、checkbox/radio/switch（勾选）、upload（上传）、navigation（导航）。

规则：
1. 必须基于截图交互分析选择尚未测试的控件
2. 若建议的操作与 history 中已成功执行的 testIntent 重复，输出 skip
3. 若页面已充分覆盖或无可测项，输出 done
4. 不要点击支付、购买、登出、删除账户等危险操作
5. click/fill 的 name 必须与截图上可见文案一致
6. fill 时 value 用合理测试数据；需要提交时 submit: true
7. testIntent 用简短中文描述测试目的，便于去重
8. **筛选区优先**：若页面有筛选/搜索表单（输入框、下拉 + 查询/搜索按钮），必须**逐个单独测试**每个筛选项：
   - 先点「重置/清空」（若有）
   - 只填写/选择**当前这一个**筛选项
   - 点「查询/搜索」
   - 观察列表/表格结果是否变化；testIntent 格式：筛选-<字段名>-单独测试
   - 所有筛选项测完后，再测其他按钮/链接
9. 优先测试 button、link、tab、dropdown；普通输入框用 fill；下拉用 click 打开
10. **不要点击标题栏/顶部的返回按钮**（Back、←、返回等）；进入二级页后框架会自动返回起始页，无需测试 UI 返回

动作类型：
- { "type": "click", "name": "按钮文案", "role": "button|link|tab", "reasoning": "...", "testIntent": "..." }
- { "type": "fill", "name": "Email", "value": "qa@example.com", "submit": true, "reasoning": "...", "testIntent": "..." }
- { "type": "scroll", "direction": "bottom"|"top", "reasoning": "...", "testIntent": "..." }
- { "type": "filterTest", "filterField": "任务名称", "filterKind": "input|dropdown", "filterValue": "test", "queryButton": "查询", "resetButton": "重置", "reasoning": "...", "testIntent": "筛选-任务名称-单独测试" }
- { "type": "skip", "reason": "重复或无需测试", "testIntent": "..." }
- { "type": "done", "summary": "页面已覆盖", "reasoning": "..." }

只输出 JSON，不要 markdown。`;

const parseExplorePlan = (content: string): ExplorePlan => {
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('LLM response is not JSON');
  return ExplorePlanSchema.parse(JSON.parse(jsonMatch[0]));
};

export const planHeuristicExplore = (input: {
  elements: ExploreElementInfo[];
  interactives?: InteractivesAnalysis;
  history: ExploreHistoryEntry[];
  fillInputs: boolean;
  siteCrawl?: boolean;
  pageUrl?: string;
}): ExplorePlan => {
  const tried = new Set(
    input.history
      .filter(h => h.success && h.plan.type !== 'skip' && h.plan.type !== 'done')
      .map(h => h.fingerprint)
  );

  const scrolled = tried.has('scroll:bottom');

  if (!scrolled && input.elements.length > 0) {
    const plan: ExplorePlan = {
      type: 'scroll',
      direction: 'bottom',
      reasoning: '先滚动到底部，发现更多可交互元素',
      testIntent: '滚动页面到底部',
    };
    if (!isDuplicateExplorePlan(plan, input.history)) return plan;
  }

  const filterPlan = planNextFilterTest(input);
  if (filterPlan && !isDuplicateExplorePlan(filterPlan, input.history)) {
    return filterPlan;
  }

  const filterPanel = detectFilterPanel(input.elements, input.interactives);
  const filterPanelActive = Boolean(filterPanel && filterPanel.fields.length > 0);
  const allFiltersTested =
    filterPanel != null &&
    filterPanel.fields.every(f => getTestedFilterFields(input.history).has(f.name.toLowerCase()));
  const queryResetPattern = /查\s*询|搜索|重\s*置|清空|search|reset|clear/i;

  const candidates = input.interactives?.interactives.length
    ? input.interactives.interactives
        .filter(
          i =>
            !i.disabled &&
            i.suggestedAction !== 'skip' &&
            !(i.kind === 'navigation' && shouldSkipHeaderBackTest(i.label))
        )
        .map(i => ({
          kind: i.kind,
          name: i.label,
          action: i.suggestedAction,
        }))
    : input.elements
        .filter(el => !el.disabled && !shouldSkipHeaderBackTest(el.name))
        .map(el => ({
          kind: el.tag,
          name: el.name,
          action: undefined as string | undefined,
        }));

  for (const item of candidates) {
    const el = input.elements.find(e => e.name === item.name);
    if (el?.disabled) continue;
    if (shouldSkipHeaderBackTest(item.name)) continue;
    if (item.kind === 'navigation' && shouldSkipHeaderBackTest(item.name)) continue;
    if (input.siteCrawl && (item.kind === 'link' || item.kind === 'a' || item.kind === 'menuitem')) {
      continue;
    }
    if (filterPanelActive && !allFiltersTested) {
      if (queryResetPattern.test(item.name)) continue;
      if (item.kind === 'input' || item.kind === 'dropdown') continue;
    }

    const isFillable =
      input.fillInputs &&
      (item.action === 'fill' ||
        item.kind === 'input' ||
        item.kind === 'textarea' ||
        el?.tag === 'input' ||
        el?.tag === 'textarea' ||
        el?.role === 'textbox');

    if (isFillable) {
      const name =
        el?.inputType === 'email' || /email/i.test(item.name)
          ? 'Email'
          : el?.inputType === 'password' || /password/i.test(item.name)
            ? 'Password'
            : item.name;
      const value =
        name === 'Email'
          ? 'qa-auto@example.com'
          : name === 'Password'
            ? 'WrongPass123!'
            : 'QA automated test';
      const plan: ExplorePlan = {
        type: 'fill',
        name,
        value,
        submit: /search|ask|prompt|message|email|name|comment|feedback/i.test(name),
        reasoning: `填写输入框 ${name}`,
        testIntent: `填写 ${name}`,
      };
      if (!tried.has(fingerprintExplorePlan(plan)) && !isDuplicateExplorePlan(plan, input.history)) {
        return plan;
      }
      continue;
    }

    if (
      item.action === 'click' ||
      item.action === 'open' ||
      item.action === 'toggle' ||
      ((item.kind === 'button' ||
        item.kind === 'link' ||
        item.kind === 'tab' ||
        item.kind === 'dropdown' ||
        el?.tag === 'button' ||
        el?.role === 'button' ||
        el?.role === 'link' ||
        el?.tag === 'a') &&
        item.kind !== 'navigation')
    ) {
      const plan: ExplorePlan = {
        type: 'click',
        name: item.name,
        role:
          item.kind === 'link'
            ? 'link'
            : item.kind === 'tab'
              ? 'tab'
              : 'button',
        reasoning: `点击 ${item.name}（${item.kind}）`,
        testIntent: `点击 ${item.name}`,
      };
      if (!tried.has(fingerprintExplorePlan(plan)) && !isDuplicateExplorePlan(plan, input.history)) {
        return plan;
      }
    }
  }

  return {
    type: 'done',
    summary: '启发式队列已耗尽或无可测项',
    reasoning: '所有可见元素均已尝试',
  };
};

export const planNextExploreAction = async (input: {
  screenshotPath: string;
  url: string;
  snapshot: string;
  elements: ExploreElementInfo[];
  interactives?: InteractivesAnalysis;
  history: ExploreHistoryEntry[];
  safeMode: boolean;
  fillInputs: boolean;
  goal?: string;
  siteCrawl?: boolean;
}): Promise<ExplorePlan> => {
  const config = getLlmConfig();
  if (!config) {
    return planHeuristicExplore({
      elements: input.elements,
      interactives: input.interactives,
      history: input.history,
      fillInputs: input.fillInputs,
      siteCrawl: input.siteCrawl,
      pageUrl: input.url,
    });
  }

  const userText = [
    input.goal ? `测试目标: ${input.goal}` : '请根据当前页面截图与交互分析，决定下一步启发式测试动作。',
    `URL: ${input.url}`,
    `已执行 ${input.history.length} 步`,
    `历史:\n${formatHistory(input.history) || '(无)'}`,
    input.interactives
      ? `页面摘要: ${input.interactives.pageSummary}\n\n可交互元素分析:\n${formatInteractivesDetail(input.interactives)}`
      : `可交互元素:\n${formatElements(input.elements) || '(无)'}`,
    `DOM 扫描:\n${formatElements(input.elements) || '(无)'}`,
    `可访问性快照:\n${truncateSnapshot(input.snapshot, 60)}`,
    '若下一步会与 history 重复，请输出 skip 而非重复操作。',
  ]
    .filter(Boolean)
    .join('\n\n');

  try {
    const content = await chatCompletion({
      model: config.visionModel,
      messages: [
        { role: 'system', content: buildSystemPrompt() },
        {
          role: 'user',
          content: [
            { type: 'text', text: userText },
            {
              type: 'image_url',
              image_url: { url: screenshotToDataUrl(input.screenshotPath), detail: 'high' },
            },
          ],
        },
      ],
    });

    const plan = parseExplorePlan(content);

    if (isHeaderBackExplorePlan(plan)) {
      return {
        type: 'skip',
        reason: headerBackSkipReason,
        testIntent: 'testIntent' in plan ? plan.testIntent : undefined,
      };
    }

    if (plan.type !== 'skip' && plan.type !== 'done' && isDuplicateExplorePlan(plan, input.history)) {
      return {
        type: 'skip',
        reason: '与已执行测试重复（客户端去重）',
        testIntent: 'testIntent' in plan ? plan.testIntent : undefined,
      };
    }

    if (isDangerousExplorePlan(plan, input.safeMode)) {
      return {
        type: 'skip',
        reason: '安全模式拦截危险操作',
        testIntent: 'testIntent' in plan ? plan.testIntent : undefined,
      };
    }

    return plan;
  } catch (err) {
    console.warn(
      `Explore planner LLM failed: ${err instanceof Error ? err.message : String(err)}; using heuristic`
    );
    return planHeuristicExplore({
      elements: input.elements,
      interactives: input.interactives,
      history: input.history,
      fillInputs: input.fillInputs,
      siteCrawl: input.siteCrawl,
      pageUrl: input.url,
    });
  }
};

export const formatExplorePlanLabel = (plan: ExplorePlan): string => {
  switch (plan.type) {
    case 'click':
      return `点击「${plan.name}」 — ${plan.testIntent}`;
    case 'fill':
      return `填写「${plan.name}」 — ${plan.testIntent}`;
    case 'scroll':
      return `滚动${plan.direction === 'bottom' ? '到底' : '到顶'} — ${plan.testIntent}`;
    case 'filterTest':
      return `筛选「${plan.filterField}」 — ${plan.testIntent}`;
    case 'skip':
      return `跳过: ${plan.reason}`;
    case 'done':
      return `完成: ${plan.summary}`;
    default:
      return 'unknown';
  }
};
