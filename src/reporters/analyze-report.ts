import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getRootDir } from '../config.js';
import { writeConsolidatedReport, type ConsolidatedReportInput } from './consolidated-report.js';
import { writeHtmlReport } from './html-report.js';
import { runScenarioVisualReview } from './visual-review.js';
import type { Scenario, ScenarioResult } from '../types.js';

const loadSummary = (summaryPath: string): ConsolidatedReportInput => {
  const parsed = JSON.parse(readFileSync(summaryPath, 'utf8')) as {
    suite: string;
    description?: string;
    startedAt: string;
    finishedAt: string;
    cases: Array<{
      path: string;
      priority?: string;
      category?: string;
      reportDir: string;
    }>;
  };

  return {
    suite: parsed.suite,
    description: parsed.description,
    startedAt: parsed.startedAt,
    finishedAt: parsed.finishedAt,
    cases: parsed.cases.map(item => ({
      path: item.path,
      priority: item.priority,
      category: item.category,
      result: JSON.parse(
        readFileSync(join(item.reportDir, 'result.json'), 'utf8')
      ) as ScenarioResult,
    })),
  };
};

export const analyzeScenarioResult = async (
  scenario: Scenario,
  result: ScenarioResult,
  options: { strict?: boolean; prompt?: string } = {}
) => {
  const review = await runScenarioVisualReview(scenario, result, options);
  if (review) {
    result.visualReview = review;
    writeFileSync(join(result.reportDir, 'result.json'), JSON.stringify(result, null, 2));
    writeHtmlReport(result);
  }
  return result;
};

export const analyzeReportTarget = async (
  targetPath: string,
  options: { strict?: boolean; prompt?: string } = {}
) => {
  const fullPath = targetPath.startsWith('/')
    ? targetPath
    : join(process.cwd(), targetPath);

  if (fullPath.endsWith('summary.json')) {
    const input = loadSummary(fullPath);
    const outputDir = join(fullPath, '..');
    for (const item of input.cases) {
      const scenario: Scenario = {
        name: item.result.name,
        env: 'dev',
        viewport: 'mobile',
        category: item.category as Scenario['category'],
        steps: [],
      };
      console.log(`\nAnalyzing ${item.path} ...`);
      item.result = await analyzeScenarioResult(scenario, item.result, options);
    }
    const { htmlPath, jsonPath } = writeConsolidatedReport(input, outputDir);
    return { htmlPath, jsonPath, count: input.cases.length };
  }

  const reportDir = existsSync(join(fullPath, 'result.json')) ? fullPath : join(fullPath, '..');
  const resultPath = join(reportDir, 'result.json');
  const result = JSON.parse(readFileSync(resultPath, 'utf8')) as ScenarioResult;
  const scenario: Scenario = {
    name: result.name,
    env: 'dev',
    viewport: 'mobile',
    steps: [],
  };
  console.log(`Analyzing ${result.name} ...`);
  await analyzeScenarioResult(scenario, result, options);
  return { htmlPath: writeHtmlReport(result), count: 1 };
};

export const findLatestRegressionSummary = () => {
  const reportsDir = join(getRootDir(), 'reports');
  if (!existsSync(reportsDir)) return undefined;

  return readdirSync(reportsDir)
    .filter(name => name.startsWith('regression-'))
    .map(name => join(reportsDir, name, 'summary.json'))
    .filter(path => existsSync(path))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
};
