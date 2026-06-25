import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  analyzeScreenshot,
  formatVisualAnalysis,
  shouldFailOnVisualAnalysis,
} from '../agent/visual-analyzer.js';
import { formatStepLabel } from '../runner/progress-overlay.js';
import type {
  AssertVisualOptions,
  Scenario,
  ScenarioResult,
  ScenarioVisualReview,
  VisualReviewOptions,
  StepResult,
} from '../types.js';

export const resolveAssertVisualOptions = (
  assertVisual: boolean | string | AssertVisualOptions
): AssertVisualOptions => {
  if (assertVisual === false || assertVisual === true) return {};
  if (typeof assertVisual === 'string') return { prompt: assertVisual };
  return assertVisual;
};

export const resolveVisualReviewOptions = (
  visualReview: boolean | VisualReviewOptions | undefined
): VisualReviewOptions | null => {
  if (!visualReview) return null;
  if (visualReview === true) return {};
  return visualReview;
};

const pickReviewStep = (steps: StepResult[]) => {
  const failed = steps.find(step => step.status === 'failed' && step.screenshot);
  if (failed) return failed;
  const withVisual = [...steps].reverse().find(step => step.visualAnalysis && step.screenshot);
  if (withVisual) return withVisual;
  return [...steps].reverse().find(step => step.screenshot);
};

export const runScenarioVisualReview = async (
  scenario: Scenario,
  result: ScenarioResult,
  options: VisualReviewOptions = {}
): Promise<ScenarioVisualReview | undefined> => {
  const step = pickReviewStep(result.steps);
  if (!step?.screenshot) return undefined;

  const stepLabel = formatStepLabel(step.step as Record<string, unknown>);
  const analysis = await analyzeScreenshot(step.screenshot, {
    scenarioName: scenario.name,
    stepLabel,
    category: scenario.category,
    customPrompt:
      options.prompt ??
      '请审查该自动化测试截图，判断页面视觉是否正常，并列出可能存在的 UI/UX 问题。',
  });

  const review: ScenarioVisualReview = {
    screenshot: step.screenshot,
    stepIndex: step.index,
    stepLabel,
    analysis,
  };

  writeFileSync(join(result.reportDir, 'visual-review.json'), JSON.stringify(review, null, 2));
  console.log(`  [visual] ${formatVisualAnalysis(analysis)}`);

  if (shouldFailOnVisualAnalysis(analysis, { strict: options.strict, category: scenario.category })) {
    result.status = 'failed';
  }

  return review;
};
