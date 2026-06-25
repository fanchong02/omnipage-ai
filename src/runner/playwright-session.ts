import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { resolveDevice, resolveEnvironment } from '../config.js';
import { seedDiscountStorage } from '../mocks/auth-seed.js';
import { getWebViewBridgeScript } from '../mocks/webview-bridge.js';
import { installProgressOverlay } from './progress-overlay.js';
import { resolveHeadless, resolveSlowMo } from './run-options.js';
import type { BrowserLogEntry, DeviceConfig, EnvironmentConfig } from '../types.js';

export type SessionOptions = {
  envName: string;
  deviceName: string;
  headless?: boolean;
  slowMo?: number;
  showProgress?: boolean;
};

export type PlaywrightSession = {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  env: EnvironmentConfig;
  device: DeviceConfig;
  close: () => Promise<void>;
};

export const createPlaywrightSession = async (
  options: SessionOptions
): Promise<PlaywrightSession> => {
  const env = resolveEnvironment(options.envName);
  const device = resolveDevice(options.deviceName);
  const headless = resolveHeadless(options.headless);
  const slowMo = options.slowMo ?? resolveSlowMo(headless);

  const browser = await chromium.launch({
    headless,
    slowMo,
  });
  const context = await browser.newContext({
    baseURL: env.baseURL,
    viewport: device.viewport,
    userAgent: device.userAgent,
    ignoreHTTPSErrors: true,
  });

  if (options.showProgress) {
    await installProgressOverlay(context);
  }

  if (device.injectWebViewBridge) {
    await context.addInitScript(getWebViewBridgeScript());
  }

  await seedDiscountStorage(context);

  const page = await context.newPage();

  const browserLogs: BrowserLogEntry[] = [];

  page.on('console', msg => {
    const level = msg.type();
    if (level !== 'error' && level !== 'warning') return;
    browserLogs.push({
      type: 'console',
      level,
      message: msg.text(),
      timestamp: new Date().toISOString(),
    });
  });
  page.on('pageerror', err => {
    browserLogs.push({
      type: 'pageerror',
      level: 'error',
      message: err.message,
      timestamp: new Date().toISOString(),
    });
  });

  (page as Page & { _qaBrowserLogs?: BrowserLogEntry[] })._qaBrowserLogs = browserLogs;

  return {
    browser,
    context,
    page,
    env,
    device,
    close: async () => {
      await context.close();
      await browser.close();
    },
  };
};

export const getBrowserLogs = (page: Page): BrowserLogEntry[] => {
  const ext = page as Page & { _qaBrowserLogs?: BrowserLogEntry[] };
  return ext._qaBrowserLogs ?? [];
};

export const getPageErrors = (page: Page) => {
  const logs = getBrowserLogs(page);
  return {
    consoleErrors: logs
      .filter(log => log.type === 'console' && log.level === 'error')
      .map(log => log.message),
    pageErrors: logs.filter(log => log.type === 'pageerror').map(log => log.message),
  };
};
