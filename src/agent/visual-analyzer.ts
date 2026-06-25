import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { chatCompletion, getLlmConfig } from './llm-client.js';

export const VisualIssueSchema = z.object({
  title: z.string(),
  description: z.string(),
  category: z.enum([
    'layout',
    'text',
    'overlap',
    'missing',
    'broken',
    'accessibility',
    'unexpected_overlay',
    'other',
  ]),
});

export const VisualAnalysisSchema = z.object({
  hasVisualIssue: z.boolean(),
  severity: z.enum(['none', 'low', 'medium', 'high']),
  summary: z.string(),
  issues: z.array(VisualIssueSchema),
  skipped: z.boolean().optional(),
  skipReason: z.string().optional(),
});

export type VisualAnalysis = z.infer<typeof VisualAnalysisSchema>;
export type VisualIssue = z.infer<typeof VisualIssueSchema>;

export type VisualAnalysisContext = {
  scenarioName?: string;
  stepLabel?: string;
  url?: string;
  category?: string;
  customPrompt?: string;
};

const toDataUrl = (screenshotPath: string) => {
  if (!existsSync(screenshotPath)) {
    throw new Error(`Screenshot not found: ${screenshotPath}`);
  }
  const base64 = readFileSync(screenshotPath).toString('base64');
  return `data:image/png;base64,${base64}`;
};

const buildSystemPrompt = () => `你是移动端 H5/Web QA 视觉审查专家。根据测试截图判断页面是否存在视觉或 UX 问题。

关注：
- 文案截断、重叠、溢出
- 按钮/表单 disabled 但场景期望可交互
- 空白页、加载失败、错误弹窗、异常遮罩
- 布局错位、元素缺失、图片破损
- 明显的可访问性问题（对比度极低、点击区域过小）

注意：
- 测试进度浮层、开发者工具图标可忽略
- abnormal 用例中「预期的错误提示/跳转」不算视觉问题
- 仅报告你有把握从截图中观察到的问题

只输出 JSON，不要 markdown：
{
  "hasVisualIssue": boolean,
  "severity": "none" | "low" | "medium" | "high",
  "summary": "一句话结论",
  "issues": [{ "title": "...", "description": "...", "category": "layout|text|overlap|missing|broken|accessibility|unexpected_overlay|other" }]
}`;

const parseVisualAnalysis = (content: string): VisualAnalysis => {
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('LLM visual response is not JSON');
  }
  return VisualAnalysisSchema.parse(JSON.parse(jsonMatch[0]));
};

const skippedAnalysis = (reason: string): VisualAnalysis => ({
  hasVisualIssue: false,
  severity: 'none',
  summary: reason,
  issues: [],
  skipped: true,
  skipReason: reason,
});

export const analyzeScreenshot = async (
  screenshotPath: string,
  context: VisualAnalysisContext = {}
): Promise<VisualAnalysis> => {
  const config = getLlmConfig();
  if (!config) {
    return skippedAnalysis('未配置 QA_LLM_API_KEY，已跳过 AI 视觉分析');
  }

  const userText = [
    context.customPrompt ?? '请分析此测试截图，判断页面视觉是否正常，并列出可能存在的问题。',
    context.scenarioName ? `场景: ${context.scenarioName}` : '',
    context.stepLabel ? `步骤: ${context.stepLabel}` : '',
    context.url ? `URL: ${context.url}` : '',
    context.category ? `用例类型: ${context.category}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const content = await chatCompletion({
    model: config.visionModel,
    messages: [
      { role: 'system', content: buildSystemPrompt() },
      {
        role: 'user',
        content: [
          { type: 'text', text: userText },
          { type: 'image_url', image_url: { url: toDataUrl(screenshotPath), detail: 'high' } },
        ],
      },
    ],
  });

  return parseVisualAnalysis(content);
};

export const shouldFailOnVisualAnalysis = (
  analysis: VisualAnalysis,
  options: { strict?: boolean; category?: string } = {}
) => {
  if (analysis.skipped || !analysis.hasVisualIssue) return false;
  if (options.strict === false) return false;
  if (options.strict === true) return true;
  if (options.category === 'abnormal' || options.category === 'edge') return false;
  return analysis.severity === 'medium' || analysis.severity === 'high';
};

export const formatVisualAnalysis = (analysis: VisualAnalysis) => {
  if (analysis.skipped) return analysis.summary;
  const issueText =
    analysis.issues.length > 0
      ? analysis.issues.map(issue => `${issue.title}: ${issue.description}`).join('; ')
      : '未发现明显问题';
  return `${analysis.summary}（严重度: ${analysis.severity}）${analysis.hasVisualIssue ? ` — ${issueText}` : ''}`;
};
