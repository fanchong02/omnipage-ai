import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { getRootDir } from './config.js';
import { getRuntimeCredentials } from './auth/runtime-credentials.js';

const AccountFieldsSchema = z.object({
  email: z.string().optional(),
  password: z.string().optional(),
  submit: z.string().optional(),
});

const AccountSchema = z.object({
  description: z.string().optional(),
  email: z.string().min(1),
  password: z.string().optional(),
  displayName: z.string().optional(),
  uid: z.string().optional(),
  accessToken: z.string().optional(),
  refreshToken: z.string().optional(),
  env: z.array(z.string()).optional(),
  loginUrl: z.string().optional(),
  fields: AccountFieldsSchema.optional(),
});

const AccountsFileSchema = z.object({
  defaults: z
    .object({
      account: z.string().optional(),
    })
    .optional(),
  accounts: z.record(z.string(), AccountSchema),
});

export type Account = z.infer<typeof AccountSchema> & { name: string };

export type AccountsFile = z.infer<typeof AccountsFileSchema>;

const ACCOUNTS_PATH = join(getRootDir(), 'config/accounts.yaml');
const ACCOUNTS_EXAMPLE_PATH = join(getRootDir(), 'config/accounts.example.yaml');

let cachedAccounts: AccountsFile | null = null;

export const getAccountsFilePath = () => ACCOUNTS_PATH;

export const loadAccountsFile = (): AccountsFile => {
  if (cachedAccounts) return cachedAccounts;

  const path = existsSync(ACCOUNTS_PATH) ? ACCOUNTS_PATH : ACCOUNTS_EXAMPLE_PATH;
  if (!existsSync(path)) {
    throw new Error(
      `Accounts file not found. Create ${ACCOUNTS_PATH} from config/accounts.example.yaml`
    );
  }

  const raw = readFileSync(path, 'utf8');
  cachedAccounts = AccountsFileSchema.parse(parseYaml(raw));
  return cachedAccounts;
};

export const listAccounts = (envName?: string): Account[] => {
  const file = loadAccountsFile();
  return Object.entries(file.accounts)
    .map(([name, account]) => ({ ...account, name }))
    .filter(account => {
      if (!envName || !account.env?.length) return true;
      return account.env.includes(envName);
    });
};

export const resolveAccount = (accountName?: string, envName?: string): Account => {
  const file = loadAccountsFile();
  const name = accountName ?? file.defaults?.account;
  if (!name) {
    throw new Error(
      'No account specified. Add `login: <name>` in scenario or set defaults.account in config/accounts.yaml'
    );
  }

  const account = file.accounts[name];
  if (!account) {
    const available = Object.keys(file.accounts).join(', ');
    throw new Error(`Unknown account "${name}". Available: ${available}`);
  }

  if (envName && account.env?.length && !account.env.includes(envName)) {
    throw new Error(
      `Account "${name}" is not allowed for env "${envName}". Allowed: ${account.env.join(', ')}`
    );
  }

  return { ...account, name };
};

/** 优先使用启动时传入的 email/password，否则回退到 accounts.yaml */
export const resolveLoginAccount = (accountName?: string, envName?: string): Account => {
  const runtime = getRuntimeCredentials();
  if (runtime?.email && runtime.password) {
    return {
      name: 'runtime',
      email: runtime.email,
      password: runtime.password,
    };
  }
  return resolveAccount(accountName, envName);
};

export const tryResolveLoginAccount = (
  accountName?: string,
  envName?: string
): Account | null => {
  const runtime = getRuntimeCredentials();
  if (runtime?.email && runtime.password) {
    return {
      name: 'runtime',
      email: runtime.email,
      password: runtime.password,
    };
  }
  try {
    return resolveAccount(accountName, envName);
  } catch {
    return null;
  }
};

export const clearAccountsCache = () => {
  cachedAccounts = null;
};
