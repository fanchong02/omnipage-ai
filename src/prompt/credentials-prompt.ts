import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { RuntimeCredentials } from '../auth/runtime-credentials.js';

export type AuthSource = 'flags' | 'env' | 'prompt' | 'mixed' | 'none';

export type ResolvedRuntimeAuth = {
  credentials: RuntimeCredentials | null;
  source: AuthSource;
};

const readEnvCredentials = (): RuntimeCredentials | null => {
  const email = (
    process.env.E2E_EMAIL ??
    process.env.E2E_ACCOUNT ??
    process.env.QA_EMAIL
  )?.trim();
  const password = (process.env.E2E_PASSWORD ?? process.env.QA_PASSWORD)?.trim();
  if (email && password) return { email, password };
  return null;
};

const resolveAuthSource = (
  emailFromFlag: boolean,
  passwordFromFlag: boolean,
  emailFromEnv: boolean,
  passwordFromEnv: boolean,
  prompted: boolean
): AuthSource => {
  if (!emailFromFlag && !passwordFromFlag && !emailFromEnv && !passwordFromEnv && !prompted) {
    return 'none';
  }
  if (prompted) return 'prompt';
  const fromFlags = emailFromFlag || passwordFromFlag;
  const fromEnv = emailFromEnv || passwordFromEnv;
  if (fromFlags && fromEnv) return 'mixed';
  if (fromEnv) return 'env';
  if (fromFlags) return 'flags';
  return 'none';
};

export const resolveRuntimeAuth = async (
  flags: {
    email?: string;
    password?: string;
    account?: string;
    'no-login'?: string;
  },
  options: { prompt?: boolean } = {}
): Promise<ResolvedRuntimeAuth> => {
  if (flags['no-login'] === 'true') {
    return { credentials: null, source: 'none' };
  }

  const emailFlag = flags.email?.trim();
  const passwordFlag = flags.password?.trim();
  const envAuth = readEnvCredentials();

  const emailFromFlag = Boolean(emailFlag);
  const passwordFromFlag = Boolean(passwordFlag);
  const emailFromEnv = Boolean(envAuth?.email && !emailFlag);
  const passwordFromEnv = Boolean(envAuth?.password && !passwordFlag);

  let email = emailFlag || envAuth?.email || '';
  let password = passwordFlag || envAuth?.password || '';

  if (email && password) {
    return {
      credentials: { email, password },
      source: resolveAuthSource(
        emailFromFlag,
        passwordFromFlag,
        emailFromEnv,
        passwordFromEnv,
        false
      ),
    };
  }

  const shouldPrompt = options.prompt ?? true;
  if (!shouldPrompt) {
    if (emailFlag && !password) {
      throw new Error('已提供 --email，请同时传入 --password 或在 .env 中设置 E2E_PASSWORD');
    }
    return { credentials: null, source: 'none' };
  }

  const rl = readline.createInterface({ input, output });
  try {
    let prompted = false;

    if (!email) {
      email = (await rl.question('登录账号/邮箱 (留空则跳过自动登录): ')).trim();
      prompted = true;
    }
    if (!email) return { credentials: null, source: 'none' };

    if (!password) {
      password = (await rl.question('登录密码: ')).trim();
      prompted = true;
    }
    if (!password) {
      throw new Error('已输入邮箱但未提供密码（可在 .env 中设置 E2E_PASSWORD）');
    }

    return {
      credentials: { email, password },
      source: prompted
        ? resolveAuthSource(emailFromFlag, passwordFromFlag, emailFromEnv, passwordFromEnv, true)
        : resolveAuthSource(emailFromFlag, passwordFromFlag, emailFromEnv, passwordFromEnv, false),
    };
  } finally {
    rl.close();
  }
};

const AUTH_SOURCE_LABEL: Record<Exclude<AuthSource, 'none'>, string> = {
  flags: '启动参数',
  env: '.env',
  prompt: '终端输入',
  mixed: '启动参数与 .env',
};

export const formatRuntimeAuthLine = (resolved: ResolvedRuntimeAuth) => {
  const auth = resolved.credentials;
  if (!auth) return '登录账号: 未配置（遇登录页不会自动登录）';
  const label =
    resolved.source === 'none' ? '配置' : AUTH_SOURCE_LABEL[resolved.source] ?? '配置';
  return `登录账号: ${auth.email} (来自${label})`;
};

export const shouldEnableAutoLogin = (
  flags: { 'no-login'?: string; account?: string },
  runtimeAuth: RuntimeCredentials | null
): boolean | string => {
  if (flags['no-login'] === 'true') return false;
  if (runtimeAuth) return true;
  if (flags.account) return flags.account;
  return false;
};
