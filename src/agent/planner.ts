import { AgentActionSchema, type AgentAction, type AgentHistoryEntry } from '../types.js';
import { truncateSnapshot } from './snapshot.js';

const extractQuotedNames = (task: string): string[] => {
  const matches = task.match(/["'「]([^"'」]+)["'」]/g) ?? [];
  return matches.map(m => m.replace(/^["'「]|["'」]$/g, ''));
};

const findNameInSnapshot = (snapshot: string, candidates: string[]): string | null => {
  const lowerSnapshot = snapshot.toLowerCase();
  for (const candidate of candidates) {
    if (lowerSnapshot.includes(candidate.toLowerCase())) {
      return candidate;
    }
  }
  return null;
};

/** Heuristic planner when no LLM API key is configured */
export const planHeuristic = (
  task: string,
  snapshot: string,
  history: AgentHistoryEntry[]
): AgentAction => {
  const taskLower = task.toLowerCase();
  const quoted = extractQuotedNames(task);
  const clickCandidates = [
    ...quoted,
    ...(taskLower.includes('get my plan') ? ['GET MY PLAN'] : []),
    ...(taskLower.includes('next step') ? ['NEXT STEP'] : []),
    ...(taskLower.includes('continue') ? ['CONTINUE'] : []),
    ...(task.match(/点击(.+?)(按钮|选项|$)/)?.[1]?.trim()
      ? [task.match(/点击(.+?)(按钮|选项|$)/)![1].trim()]
      : []),
  ].filter(Boolean);

  const alreadyClicked = new Set(
    history
      .filter(h => h.action.type === 'click' && h.success)
      .map(h => (h.action.type === 'click' ? h.action.name : ''))
  );

  for (const name of clickCandidates) {
    if (alreadyClicked.has(name)) continue;
    if (findNameInSnapshot(snapshot, [name])) {
      return { type: 'click', role: 'button', name };
    }
  }

  if (taskLower.includes('滚动') || taskLower.includes('scroll')) {
    if (taskLower.includes('底') || taskLower.includes('bottom')) {
      return { type: 'scroll', direction: 'bottom' };
    }
    return { type: 'scroll', direction: 'top' };
  }

  if (
    taskLower.includes('确认') ||
    taskLower.includes('验证') ||
    taskLower.includes('assert')
  ) {
    const assertName = quoted[0] ?? clickCandidates[0];
    if (assertName && findNameInSnapshot(snapshot, [assertName])) {
      return { type: 'assertVisible', name: assertName };
    }
  }

  if (history.length >= 8) {
    return { type: 'done', summary: 'Max agent steps reached' };
  }

  return { type: 'wait', ms: 500 };
};

export const planWithLlm = async (
  task: string,
  snapshot: string,
  url: string,
  history: AgentHistoryEntry[]
): Promise<AgentAction> => {
  const apiKey = process.env.QA_LLM_API_KEY?.trim();
  if (!apiKey) {
    return planHeuristic(task, snapshot, history);
  }

  const baseUrl = (process.env.QA_LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = process.env.QA_LLM_MODEL || 'gpt-4o-mini';

  const systemPrompt = `You are a web QA agent. Given an accessibility snapshot and task, output ONE JSON action.
Allowed types: click (name required, role optional), fill (name, value), scroll (direction: bottom|top), wait (ms), assertVisible (name), done (summary).
Respond with JSON only, no markdown.`;

  const userPrompt = JSON.stringify({
    task,
    url,
    snapshot: truncateSnapshot(snapshot),
    history: history.slice(-5).map(h => ({ action: h.action, success: h.success })),
  });

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  });

  if (!response.ok) {
    console.warn(`LLM planner failed (${response.status}), falling back to heuristic`);
    return planHeuristic(task, snapshot, history);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content?.trim() ?? '';
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return planHeuristic(task, snapshot, history);
  }

  try {
    const parsed = AgentActionSchema.parse(JSON.parse(jsonMatch[0]));
    return parsed;
  } catch {
    return planHeuristic(task, snapshot, history);
  }
};

export const planNextAction = async (input: {
  task: string;
  snapshot: string;
  url: string;
  history: AgentHistoryEntry[];
}): Promise<AgentAction> => {
  return planWithLlm(input.task, input.snapshot, input.url, input.history);
};
