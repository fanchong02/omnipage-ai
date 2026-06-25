import type { MockRoute } from './route-interceptor.js';

/** AI Tools 对话/上传/历史 API mock（场景可按需引用） */
export const AI_TOOLS_MOCKS: MockRoute[] = [
  {
    pattern: '**/ml/aiTools/models/**',
    fixture: 'fixtures/ai-tools-models.json',
  },
  {
    pattern: '**/ml/aiTools/modelUsages/**',
    fixture: 'fixtures/ai-tools-usages.json',
  },
  {
    pattern: '**/ml/aiTools/files/**',
    fixture: 'fixtures/ai-tools-upload.json',
  },
  {
    pattern: '**/ml/aiTools/completions/**',
    fixture: 'fixtures/ai-tools-completion.json',
  },
  {
    pattern: '**/ml/aiTools/completionDetail/**',
    fixture: 'fixtures/ai-tools-completion.json',
  },
  {
    pattern: '**/ml/aiTools/conversationDetail/**',
    fixture: 'fixtures/ai-tools-completion.json',
  },
  {
    pattern: '**/ml/aiTools/conversations/**',
    fixture: 'fixtures/ai-tools-conversations.json',
  },
];
