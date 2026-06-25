import { z } from 'zod';

export const ScenarioStepSchema = z.union([
  z.object({ goto: z.string() }),
  z.object({ click: z.string() }),
  z.object({ fill: z.object({ selector: z.string(), value: z.string(), submit: z.boolean().optional() }) }),
  z.object({ upload: z.object({ file: z.string(), selector: z.string().optional() }) }),
  z.object({ assertVisible: z.string() }),
  z.object({ assertUrl: z.string() }),
  z.object({ assertNoOverflow: z.string() }),
  z.object({
    assertVisual: z.union([
      z.boolean(),
      z.string(),
      z.object({
        prompt: z.string().optional(),
        strict: z.boolean().optional(),
      }),
    ]),
  }),
  z.object({ wait: z.number() }),
  z.object({ scroll: z.enum(['bottom', 'top']) }),
  z.object({ screenshot: z.string() }),
  z.object({ agent: z.string() }),
  z.object({
    explore: z.union([
      z.boolean(),
      z.object({
        maxActions: z.number().optional(),
        fillInputs: z.boolean().optional(),
        scroll: z.boolean().optional(),
        safeMode: z.boolean().optional(),
        navigateBack: z.boolean().optional(),
        aiMode: z.boolean().optional(),
        goal: z.string().optional(),
      }),
    ]),
  }),
  z.object({
    login: z.union([
      z.string(),
      z.object({
        account: z.string().optional(),
        path: z.string().optional(),
      }),
    ]),
  }),
  z.object({ seedAuth: z.record(z.string(), z.unknown()).optional() }),
]);

export type ScenarioStep = z.infer<typeof ScenarioStepSchema>;

export const ScenarioSchema = z.object({
  name: z.string(),
  category: z.enum(['normal', 'abnormal', 'edge']).optional(),
  module: z.string().optional(),
  description: z.string().optional(),
  env: z.string().default('default'),
  viewport: z.string().default('mobile'),
  autoLogin: z.union([z.boolean(), z.string()]).optional(),
  autoExplore: z
    .union([
      z.boolean(),
      z.object({
        maxActions: z.number().optional(),
        fillInputs: z.boolean().optional(),
        scroll: z.boolean().optional(),
        safeMode: z.boolean().optional(),
        navigateBack: z.boolean().optional(),
        aiMode: z.boolean().optional(),
        goal: z.string().optional(),
      }),
    ])
    .optional(),
  visualReview: z
    .union([
      z.boolean(),
      z.object({
        strict: z.boolean().optional(),
        prompt: z.string().optional(),
      }),
    ])
    .optional(),
  mockPreset: z.enum(['ai-tools']).optional(),
  retries: z.number().optional(),
  mocks: z
    .array(
      z.object({
        pattern: z.string(),
        fixture: z.string().optional(),
        body: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .optional(),
  steps: z.array(ScenarioStepSchema),
});

export type Scenario = z.infer<typeof ScenarioSchema>;

export type ExploreStepOptions = {
  maxActions?: number;
  fillInputs?: boolean;
  scroll?: boolean;
  safeMode?: boolean;
  navigateBack?: boolean;
  aiMode?: boolean;
  goal?: string;
};

export type AssertVisualOptions = {
  prompt?: string;
  strict?: boolean;
};

export type VisualReviewOptions = {
  strict?: boolean;
  prompt?: string;
};

export const AgentActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('click'), role: z.string().optional(), name: z.string() }),
  z.object({ type: z.literal('fill'), role: z.string().optional(), name: z.string(), value: z.string() }),
  z.object({ type: z.literal('scroll'), direction: z.enum(['bottom', 'top']) }),
  z.object({ type: z.literal('wait'), ms: z.number() }),
  z.object({ type: z.literal('assertVisible'), name: z.string() }),
  z.object({ type: z.literal('done'), summary: z.string().optional() }),
]);

export type AgentAction = z.infer<typeof AgentActionSchema>;

export type VisualIssue = {
  title: string;
  description: string;
  category:
    | 'layout'
    | 'text'
    | 'overlap'
    | 'missing'
    | 'broken'
    | 'accessibility'
    | 'unexpected_overlay'
    | 'other';
};

export type VisualAnalysis = {
  hasVisualIssue: boolean;
  severity: 'none' | 'low' | 'medium' | 'high';
  summary: string;
  issues: VisualIssue[];
  skipped?: boolean;
  skipReason?: string;
};

export type BrowserLogEntry = {
  type: 'console' | 'pageerror';
  level: 'error' | 'warning' | 'info' | 'debug' | 'log';
  message: string;
  timestamp: string;
};

export type StepResult = {
  index: number;
  step: ScenarioStep;
  status: 'passed' | 'failed';
  message?: string;
  exploreReportDir?: string;
  screenshot?: string;
  durationMs: number;
  browserLogs?: BrowserLogEntry[];
  visualAnalysis?: VisualAnalysis;
};

export type ScenarioVisualReview = {
  screenshot: string;
  stepIndex: number;
  stepLabel: string;
  analysis: VisualAnalysis;
};

export type ScenarioResult = {
  name: string;
  status: 'passed' | 'failed';
  steps: StepResult[];
  startedAt: string;
  finishedAt: string;
  reportDir: string;
  browserLogs?: BrowserLogEntry[];
  visualReview?: ScenarioVisualReview;
};

export type EnvironmentConfig = {
  baseURL: string;
  apiHosts?: string[];
};

export type DeviceConfig = {
  viewport: { width: number; height: number };
  userAgent?: string;
  injectWebViewBridge?: boolean;
};

export type AgentHistoryEntry = {
  action: AgentAction;
  success: boolean;
  error?: string;
};
