import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

export const normalizeTargetUrl = (raw: string): string => {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('URL 不能为空');
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  if (trimmed.startsWith('/')) {
    const base = process.env.E2E_BASE_URL?.trim();
    if (!base) {
      throw new Error('相对路径需要设置 E2E_BASE_URL，请使用完整 URL（如 https://example.com/page）');
    }
    return new URL(trimmed, base).href;
  }
  return `https://${trimmed}`;
};

export const extractOrigin = (url: string): string => new URL(url).origin;

export const applyTargetBaseUrl = (url: string): string => {
  const origin = extractOrigin(url);
  process.env.E2E_BASE_URL = origin;
  return origin;
};

export const resolveTargetUrl = async (
  urlFlag: string | undefined,
  prompt = '请输入要测试的页面 URL: '
): Promise<string> => {
  if (urlFlag?.trim()) {
    return normalizeTargetUrl(urlFlag);
  }

  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(prompt);
    return normalizeTargetUrl(answer);
  } finally {
    rl.close();
  }
};

export const resolveTargetUrls = async (options: {
  url?: string;
  urls?: string;
  prompt?: string;
}): Promise<string[]> => {
  if (options.urls?.trim()) {
    return options.urls
      .split(',')
      .map(part => normalizeTargetUrl(part.trim()))
      .filter(Boolean);
  }
  if (options.url?.trim()) {
    return [normalizeTargetUrl(options.url)];
  }
  const single = await resolveTargetUrl(undefined, options.prompt);
  return [single];
};
