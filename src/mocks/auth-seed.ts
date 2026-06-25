import type { BrowserContext } from '@playwright/test';

export type AuthSeedOptions = {
  email?: string;
  displayName?: string;
  uid?: string;
  accessToken?: string;
  refreshToken?: string;
  isAnonymous?: boolean;
};

const DEFAULT_AUTH = {
  uid: 'e2e-test-uid',
  email: 'test@example.com',
  displayName: 'Test User',
};

export const createE2eJwt = (expiresInSeconds = 365 * 24 * 3600) => {
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ exp, sub: DEFAULT_AUTH.uid })).toString('base64url');
  return `${header}.${body}.e2e-sig`;
};

/** Generic zustand-style auth persist payload for seedAuth steps */
export const buildAuthPersistPayload = (options: AuthSeedOptions = {}) => {
  const merged = { ...DEFAULT_AUTH, ...options };
  return {
    state: {
      user: {
        uid: merged.uid,
        email: merged.email,
        displayName: merged.displayName,
        avatarUrl: '',
      },
      isAnonymous: options.isAnonymous ?? true,
      accessToken: merged.accessToken ?? createE2eJwt(),
      refreshToken: merged.refreshToken ?? createE2eJwt(),
    },
    version: 0,
  };
};

export const seedAuthStorage = async (
  context: BrowserContext,
  options: AuthSeedOptions = {}
) => {
  const payload = buildAuthPersistPayload(options);
  await context.addInitScript(
    `(() => {
      const data = ${JSON.stringify({ key: 'auth.store.persist', value: payload })};
      localStorage.setItem(data.key, JSON.stringify(data.value));
    })();`
  );
};

export const seedDiscountStorage = async (context: BrowserContext) => {
  await context.addInitScript(`
    localStorage.setItem('discount.store.persist', JSON.stringify({
      state: { discountInfo: { discount: 0.5, code: 'E2E50' } },
      version: 0,
    }));
  `);
};
