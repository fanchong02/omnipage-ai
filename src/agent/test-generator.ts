import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { chatCompletion, getLlmConfig } from './llm-client.js';
import { tagInteractiveElements, type DiscoveredElement } from './page-explorer.js';
import { captureAccessibilitySnapshot, truncateSnapshot } from './snapshot.js';
import { analyzeScreenshot, type VisualAnalysis } from './visual-analyzer.js';
import { capturePageScreenshot } from '../runner/progress-overlay.js';
import { ScenarioSchema, ScenarioStepSchema, type Scenario } from '../types.js';

const GeneratedScenarioSchema = z.object({
  name: z.string(),
  category: z.enum(['normal', 'abnormal', 'edge']).default('normal'),
  module: z.string().optional(),
  description: z.string(),
  steps: z.array(ScenarioStepSchema).min(1),
});

const TestGenerationResultSchema = z.object({
  pageSummary: z.string(),
  detectedFeatures: z.array(z.string()),
  testIdeas: z.array(z.string()).optional(),
  scenarios: z.array(GeneratedScenarioSchema).min(1),
});

export type GeneratedScenario = z.infer<typeof GeneratedScenarioSchema>;
export type TestGenerationResult = z.infer<typeof TestGenerationResultSchema> & {
  visualAnalysis?: VisualAnalysis;
  screenshotPath: string;
  url: string;
  snapshot: string;
  elements: DiscoveredElement[];
};

export type AutogenOptions = {
  reportDir: string;
  env?: string;
  viewport?: string;
  goal?: string;
  maxScenarios?: number;
};

const screenshotToDataUrl = (screenshotPath: string) => {
  if (!existsSync(screenshotPath)) throw new Error(`Screenshot not found: ${screenshotPath}`);
  return `data:image/png;base64,${readFileSync(screenshotPath).toString('base64')}`;
};

const buildSystemPrompt = () => `你是移动端 H5/Web 自动化测试设计专家。根据页面截图、可访问性快照和交互元素列表，生成可执行的 YAML 测试场景。

可用步骤类型（JSON 格式，与框架一致）：
- { "goto": "/relative-path" } — 仅路径，不含域名
- { "click": "按钮或链接可见文案" }
- { "fill": { "selector": "Email|Password|Ask anything|...", "value": "具体值", "submit": true } }
- { "upload": { "file": "fixtures/test-image.png" } }
- { "assertVisible": "页面上应出现的文案" }
- { "assertUrl": "url片段" }
- { "wait": 2000 }
- { "scroll": "bottom" | "top" }
- { "login": { "account": "e2e" } }
- { "explore": true }

规则：
1. steps 从当前页面状态开始，通常不必重复 goto 当前 URL
2. 正常流填真实测试数据；异常流用非法输入
3. 不要生成支付、删除账户、登出等危险操作
4. selector/click 文案必须与截图和元素列表一致
5. 生成 1~3 个场景：至少 1 个 normal

只输出 JSON：
{
  "pageSummary": "...",
  "detectedFeatures": ["..."],
  "testIdeas": ["..."],
  "scenarios": [{ "name": "...", "category": "normal", "module": "...", "description": "...", "steps": [] }]
}`;

const parseGenerationResult = (content: string) => {
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('LLM response is not JSON');
  return TestGenerationResultSchema.parse(JSON.parse(jsonMatch[0]));
};

const formatElements = (elements: DiscoveredElement[]) =>
  elements
    .slice(0, 40)
    .map(
      el =>
        `- [${el.role || el.tag}] "${el.name}"${el.disabled ? ' (disabled)' : ''}${el.inputType ? ` type=${el.inputType}` : ''}`
    )
    .join('\n');

const toScenario = (
  generated: GeneratedScenario,
  options: AutogenOptions,
  currentUrl: string
): Scenario => {
  const pathname = (() => {
    try {
      return new URL(currentUrl).pathname;
    } catch {
      return currentUrl;
    }
  })();

  const steps = generated.steps.map(step => {
    if ('goto' in step && step.goto.startsWith('http')) {
      try {
        const u = new URL(step.goto);
        return { goto: u.pathname + u.search };
      } catch {
        return step;
      }
    }
    return step;
  });

  const hasGoto = steps.some(s => 'goto' in s);
  const finalSteps = hasGoto ? steps : [{ goto: pathname }, ...steps];

  return ScenarioSchema.parse({
    name: generated.name,
    category: generated.category,
    module: generated.module ?? 'autogen',
    description: generated.description,
    env: options.env ?? 'dev',
    viewport: options.viewport ?? 'mobile',
    autoLogin: false,
    steps: finalSteps,
  });
};

export const generateTestsFromPage = async (
  page: Page,
  options: AutogenOptions
): Promise<TestGenerationResult> => {
  mkdirSync(options.reportDir, { recursive: true });

  const screenshotPath = join(options.reportDir, 'page.png');
  await capturePageScreenshot(page, { path: screenshotPath, fullPage: true });

  const url = page.url();
  const snapshot = truncateSnapshot(await captureAccessibilitySnapshot(page), 80);
  const elements = await tagInteractiveElements(page);

  const visualAnalysis = await analyzeScreenshot(screenshotPath, {
    stepLabel: '页面初始状态',
    url,
    customPrompt: '识别页面上可测试的功能、表单、按钮与异常状态，为生成 E2E 用例提供依据。',
  });

  const config = getLlmConfig();
  if (!config) {
    const fallback = buildFallbackScenarios(url, elements, visualAnalysis);
    return { ...fallback, visualAnalysis, screenshotPath, url, snapshot, elements };
  }

  const userText = [
    options.goal ? `测试目标: ${options.goal}` : '请根据页面生成自动化测试场景。',
    `当前 URL: ${url}`,
    `视觉分析: ${visualAnalysis.summary}`,
    visualAnalysis.issues.length > 0
      ? `视觉问题: ${visualAnalysis.issues.map(i => i.title).join('; ')}`
      : '',
    `可交互元素:\n${formatElements(elements)}`,
    `可访问性快照:\n${snapshot}`,
    `最多生成 ${options.maxScenarios ?? 3} 个场景。`,
  ]
    .filter(Boolean)
    .join('\n\n');

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

  const parsed = parseGenerationResult(content);
  return { ...parsed, visualAnalysis, screenshotPath, url, snapshot, elements };
};

const buildFallbackScenarios = (
  url: string,
  elements: DiscoveredElement[],
  visualAnalysis: VisualAnalysis
): z.infer<typeof TestGenerationResultSchema> => {
  const pathname = (() => {
    try {
      return new URL(url).pathname;
    } catch {
      return url;
    }
  })();

  const fillable = elements.find(
    el =>
      !el.disabled &&
      (el.tag === 'input' || el.tag === 'textarea') &&
      el.name &&
      !/password/i.test(el.name)
  );
  const fillSelector = fillable
    ? /email|@/i.test(fillable.name) || fillable.inputType === 'email'
      ? 'Email'
      : fillable.name
    : null;
  const primaryButton = elements.find(
    el => !el.disabled && (el.role === 'button' || el.tag === 'button') && el.name
  );

  const steps: z.infer<typeof ScenarioStepSchema>[] = [{ wait: 2000 }];

  if (fillSelector) {
    steps.push({
      fill: {
        selector: fillSelector,
        value: fillSelector === 'Email' ? 'qa-auto@example.com' : 'E2E automated test input',
        submit: true,
      },
    });
  } else if (primaryButton) {
    steps.push({ click: primaryButton.name });
  }

  const urlFragment = pathname.split('/').filter(Boolean).pop() ?? 'page';
  steps.push({ assertUrl: urlFragment });

  return {
    pageSummary: visualAnalysis.summary || '未配置 QA_LLM_API_KEY，使用启发式生成',
    detectedFeatures: elements.slice(0, 8).map(el => `${el.role || el.tag}: ${el.name}`),
    testIdeas: ['配置 QA_LLM_API_KEY 后可生成更完整的测试场景'],
    scenarios: [
      {
        name: `autogen-${urlFragment}-normal`,
        category: 'normal',
        module: 'autogen',
        description: '启发式自动生成：尝试页面主交互',
        steps,
      },
    ],
  };
};

export const scenariosFromGeneration = (
  result: TestGenerationResult,
  options: AutogenOptions
): Scenario[] => result.scenarios.map(s => toScenario(s, options, result.url));

export const writeAutogenArtifacts = (
  result: TestGenerationResult,
  scenarios: Scenario[],
  outputDir: string
) => {
  mkdirSync(outputDir, { recursive: true });

  writeFileSync(
    join(outputDir, 'analysis.json'),
    JSON.stringify(
      {
        url: result.url,
        pageSummary: result.pageSummary,
        detectedFeatures: result.detectedFeatures,
        testIdeas: result.testIdeas,
        visualAnalysis: result.visualAnalysis,
        elementCount: result.elements.length,
        scenarios: result.scenarios,
      },
      null,
      2
    )
  );

  scenarios.forEach((scenario, index) => {
    writeFileSync(join(outputDir, `${scenario.name}.yaml`), stringifyYaml(scenario));
    if (index === 0) {
      writeFileSync(join(outputDir, 'generated.yaml'), stringifyYaml(scenario));
    }
  });

  const escapeHtml = (v: string) =>
    v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>Autogen — ${escapeHtml(result.url)}</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 24px; background: #f8f9fa; max-width: 960px; }
    .shot { max-width: 100%; border: 1px solid #ddd; border-radius: 8px; }
    .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 16px; margin: 16px 0; }
    .tag { display: inline-block; background: #eff6ff; color: #1d4ed8; padding: 2px 8px; border-radius: 999px; font-size: 12px; margin: 2px 4px 2px 0; }
    pre { background: #f3f4f6; padding: 12px; border-radius: 8px; overflow: auto; font-size: 12px; }
  </style>
</head>
<body>
  <h1>AI 自动生成测试</h1>
  <p><strong>URL:</strong> ${escapeHtml(result.url)}</p>
  <p>${escapeHtml(result.pageSummary)}</p>
  <img class="shot" src="page.png" alt="screenshot" />
  <div class="card">
    <h2>识别功能</h2>
    ${result.detectedFeatures.map(f => `<span class="tag">${escapeHtml(f)}</span>`).join('')}
  </div>
  ${
    result.visualAnalysis
      ? `<div class="card"><h2>视觉分析</h2><p>${escapeHtml(result.visualAnalysis.summary)}</p></div>`
      : ''
  }
  <div class="card">
    <h2>生成场景 (${scenarios.length})</h2>
    ${scenarios
      .map(
        s =>
          `<h3>${escapeHtml(s.name)}</h3><p>${escapeHtml(s.description ?? '')}</p><pre>${escapeHtml(stringifyYaml(s))}</pre>`
      )
      .join('')}
  </div>
</body>
</html>`;

  writeFileSync(join(outputDir, 'index.html'), html);
};
