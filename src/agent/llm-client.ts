export type LlmConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  visionModel: string;
};

export const getLlmConfig = (): LlmConfig | null => {
  const apiKey = process.env.QA_LLM_API_KEY?.trim();
  if (!apiKey) return null;

  const baseUrl = (process.env.QA_LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = process.env.QA_LLM_MODEL || 'gpt-4o-mini';
  const visionModel = process.env.QA_LLM_VISION_MODEL || model;

  return { apiKey, baseUrl, model, visionModel };
};

export const isLlmConfigured = () => Boolean(getLlmConfig());

export const getLlmConfigHint = () =>
  '未配置 QA_LLM_API_KEY：截图分析 / AI 逐步思考已降级为 DOM 扫描。请在项目根目录 .env 中设置 QA_LLM_API_KEY（需支持 vision 的模型，如 gpt-4o-mini）';

export const chatCompletion = async (input: {
  model: string;
  messages: Array<Record<string, unknown>>;
  temperature?: number;
}) => {
  const config = getLlmConfig();
  if (!config) throw new Error('QA_LLM_API_KEY is not configured');

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: input.model,
      temperature: input.temperature ?? 0,
      messages: input.messages,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`LLM request failed (${response.status}): ${body.slice(0, 300)}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content?.trim() ?? '';
};
