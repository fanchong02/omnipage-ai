import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { chatCompletion, getLlmConfig } from './llm-client.js';
import type { ExploreElementInfo } from './explore-planner.js';
import { shouldSkipHeaderBackTest, headerBackSkipReason } from './explore-navigation.js';

export const InteractiveKindSchema = z.enum([
  'button',
  'link',
  'tab',
  'dropdown',
  'input',
  'textarea',
  'checkbox',
  'radio',
  'switch',
  'upload',
  'navigation',
  'other',
]);

export const DetectedInteractiveSchema = z.object({
  kind: InteractiveKindSchema,
  label: z.string(),
  location: z.string().optional(),
  disabled: z.boolean().optional(),
  suggestedAction: z.enum(['click', 'fill', 'open', 'toggle', 'scroll', 'skip']).optional(),
  notes: z.string().optional(),
});

export const InteractivesAnalysisSchema = z.object({
  pageSummary: z.string(),
  interactives: z.array(DetectedInteractiveSchema),
  skipped: z.boolean().optional(),
  skipReason: z.string().optional(),
});

export type DetectedInteractive = z.infer<typeof DetectedInteractiveSchema>;
export type InteractivesAnalysis = z.infer<typeof InteractivesAnalysisSchema>;

const screenshotToDataUrl = (screenshotPath: string) => {
  if (!existsSync(screenshotPath)) throw new Error(`Screenshot not found: ${screenshotPath}`);
  return `data:image/png;base64,${readFileSync(screenshotPath).toString('base64')}`;
};

const buildSystemPrompt = () => `你是移动端 H5/Web UI 交互分析专家。根据截图识别页面上**所有可交互**区域。

必须识别的类型（kind）：
- button：按钮（CTA、提交、关闭、图标按钮等）
- link：文字/图标链接、卡片跳转
- tab：底部 Tab、顶部 Tab、分段控件
- dropdown：下拉选择、Select、Picker、展开菜单
- input：单行输入框（email、password、search 等）
- textarea：多行输入
- checkbox / radio / switch：勾选、单选、开关
- upload：上传文件/图片入口
- navigation：返回、面包屑、侧栏导航（**标题栏 Back/返回 标记 suggestedAction: skip，不要作为测试目标**）
- other：其他可点击/可操作控件

规则：
1. 只列出截图中**可见**且用户可操作的元素
2. label 必须与截图上可见文案一致（无文案则用 placeholder 或 aria 含义描述）
3. disabled 的元素也要列出并标记 disabled: true
4. suggestedAction：click / fill / open（下拉展开）/ toggle / scroll / skip
5. location 简要描述位置（如「顶部导航」「底部 Tab 栏」「表单区」「筛选区」）
6. 标题栏/顶部的 Back、←、返回 按钮：kind 设为 navigation，suggestedAction 设为 skip，notes 说明「非必要不测试」
7. **筛选区**：查询/搜索栏附近的 input、dropdown 标记 location 为「筛选区」；查询/重置按钮标记 location 为「筛选区」
8. 忽略测试进度浮层、开发者工具

只输出 JSON：
{
  "pageSummary": "一句话描述当前页面与主要可测区域",
  "interactives": [
    {
      "kind": "button",
      "label": "Sign In",
      "location": "表单底部",
      "disabled": false,
      "suggestedAction": "click",
      "notes": "可选说明"
    }
  ]
}`;

const parseAnalysis = (content: string): InteractivesAnalysis => {
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('LLM interactives response is not JSON');
  return InteractivesAnalysisSchema.parse(JSON.parse(jsonMatch[0]));
};

const inferKindFromDom = (el: ExploreElementInfo): DetectedInteractive['kind'] => {
  if (el.tag === 'select' || el.role === 'combobox' || el.role === 'listbox') return 'dropdown';
  if (el.tag === 'textarea' || el.role === 'textbox') return el.tag === 'textarea' ? 'textarea' : 'input';
  if (el.inputType === 'checkbox' || el.role === 'checkbox') return 'checkbox';
  if (el.inputType === 'radio' || el.role === 'radio') return 'radio';
  if (el.role === 'switch') return 'switch';
  if (el.inputType === 'file') return 'upload';
  if (el.role === 'tab') return 'tab';
  if (el.tag === 'a' || el.role === 'link') return 'link';
  if (/back|返回|nav/i.test(el.name) && shouldSkipHeaderBackTest(el.name)) return 'navigation';
  if (el.tag === 'input') return 'input';
  if (el.tag === 'button' || el.role === 'button') return 'button';
  return 'other';
};

const inferSuggestedAction = (
  kind: DetectedInteractive['kind'],
  label: string
): DetectedInteractive['suggestedAction'] => {
  if (kind === 'navigation' && shouldSkipHeaderBackTest(label)) return 'skip';
  switch (kind) {
    case 'input':
    case 'textarea':
      return 'fill';
    case 'dropdown':
      return 'open';
    case 'checkbox':
    case 'radio':
    case 'switch':
      return 'toggle';
    default:
      return 'click';
  }
};

export const buildInteractivesFromDom = (elements: ExploreElementInfo[]): InteractivesAnalysis => {
  const hasQueryButton = elements.some(
    el => (el.tag === 'button' || el.role === 'button') && /查\s*询|搜索|search|筛选|filter/i.test(el.name)
  );

  const interactives = elements.map(el => {
    const kind = inferKindFromDom(el);
    const label = el.name || el.inputType || el.tag;
    const skipBack = kind === 'navigation' && shouldSkipHeaderBackTest(label);
    const inFilterArea =
      hasQueryButton &&
      (kind === 'input' || kind === 'dropdown') &&
      !/email|password|邮箱|密码|账号|用户名|login/i.test(label);
    return {
      kind,
      label,
      location: inFilterArea ? '筛选区' : undefined,
      disabled: el.disabled,
      suggestedAction: el.disabled || skipBack ? 'skip' : inferSuggestedAction(kind, label),
      notes: skipBack
        ? headerBackSkipReason
        : `[${el.role || el.tag}]${el.inputType ? ` type=${el.inputType}` : ''}`,
    };
  });

  const byKind = new Map<string, number>();
  for (const item of interactives) {
    byKind.set(item.kind, (byKind.get(item.kind) ?? 0) + 1);
  }
  const breakdown = [...byKind.entries()]
    .map(([kind, count]) => `${kind}×${count}`)
    .join('、');

  return {
    pageSummary:
      elements.length > 0
        ? `DOM 扫描：${elements.length} 个可交互元素${breakdown ? `（${breakdown}）` : ''}`
        : 'DOM 扫描：未发现可交互元素',
    interactives,
    skipped: true,
    skipReason: '未配置 QA_LLM_API_KEY，使用 DOM 扫描',
  };
};

export const mergeInteractivesAnalysis = (
  vision: InteractivesAnalysis,
  domElements: ExploreElementInfo[]
): InteractivesAnalysis => {
  const domFallback = buildInteractivesFromDom(domElements);
  const seen = new Set(vision.interactives.map(i => `${i.kind}:${i.label.toLowerCase()}`));
  const merged = [...vision.interactives];

  for (const item of domFallback.interactives) {
    const key = `${item.kind}:${item.label.toLowerCase()}`;
    if (!seen.has(key)) {
      merged.push({ ...item, notes: `DOM 补充: ${item.notes ?? ''}`.trim() });
      seen.add(key);
    }
  }

  return {
    ...vision,
    interactives: merged,
  };
};

export const analyzePageInteractives = async (
  screenshotPath: string,
  context: { url?: string; domElements?: ExploreElementInfo[] } = {}
): Promise<InteractivesAnalysis> => {
  const config = getLlmConfig();
  const domElements = context.domElements ?? [];

  if (!config) {
    return buildInteractivesFromDom(domElements);
  }

  const userText = [
    '请分析截图中所有可交互元素（按钮、下拉、链接、Tab、输入框等）。',
    context.url ? `URL: ${context.url}` : '',
    domElements.length > 0
      ? `DOM 扫描参考（可与截图交叉验证）:\n${domElements
          .slice(0, 25)
          .map(el => `- [${el.role || el.tag}] "${el.name}"${el.disabled ? ' (disabled)' : ''}`)
          .join('\n')}`
      : '',
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
              image_url: { url: screenshotToDataUrl(screenshotPath), detail: 'high' },
            },
          ],
        },
      ],
    });

    const vision = parseAnalysis(content);
    return domElements.length > 0 ? mergeInteractivesAnalysis(vision, domElements) : vision;
  } catch (err) {
    console.warn(
      `Interactives vision analysis failed: ${err instanceof Error ? err.message : String(err)}; using DOM`
    );
    return buildInteractivesFromDom(domElements);
  }
};

export const formatInteractivesSummary = (analysis: InteractivesAnalysis): string => {
  if (analysis.interactives.length === 0) return '未发现可交互元素';

  const byKind = new Map<string, string[]>();
  for (const item of analysis.interactives) {
    const list = byKind.get(item.kind) ?? [];
    list.push(item.disabled ? `${item.label}(disabled)` : item.label);
    byKind.set(item.kind, list);
  }

  const parts = [...byKind.entries()].map(([kind, labels]) => {
    const shown = labels.slice(0, 4).join('、');
    const more = labels.length > 4 ? ` 等${labels.length}个` : '';
    return `${kind}: ${shown}${more}`;
  });

  return parts.join(' | ');
};

export const formatInteractivesDetail = (analysis: InteractivesAnalysis): string =>
  analysis.interactives
    .map(item => {
      const loc = item.location ? `@${item.location}` : '';
      const action = item.suggestedAction ? `→${item.suggestedAction}` : '';
      const dis = item.disabled ? ' [disabled]' : '';
      return `  - [${item.kind}] "${item.label}"${loc}${action}${dis}`;
    })
    .join('\n');
