import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext, Page, Route } from '@playwright/test';
import { getRootDir } from '../config.js';

export type MockRoute = {
  pattern: string;
  fixture?: string;
  body?: Record<string, unknown>;
};

const globToRegExp = (pattern: string) =>
  new RegExp(
    pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '.*')
      .replace(/\*/g, '[^/]*')
  );

const matchesPattern = (url: string, pattern: string) => globToRegExp(pattern).test(url);

const fulfillMock = async (route: Route, mock: MockRoute) => {
  const request = route.request();
  if (request.method() === 'OPTIONS') {
    await route.fulfill({
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': '*',
      },
    });
    return;
  }

  let body: unknown = mock.body;
  if (mock.fixture) {
    const fullPath = join(getRootDir(), mock.fixture);
    body = JSON.parse(readFileSync(fullPath, 'utf8'));
  }

  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: {
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body ?? { code: 200, data: {} }),
  });
};

export const setupRouteMocks = async (
  target: BrowserContext | Page,
  mocks: MockRoute[] = []
) => {
  for (const mock of mocks) {
    await target.route(
      url => matchesPattern(typeof url === 'string' ? url : url.href, mock.pattern),
      route => fulfillMock(route, mock)
    );
  }
};

/** 订阅/下单流程的通用 API mock（场景可按需引用） */
export const DEFAULT_SUBSCRIPTION_MOCKS: MockRoute[] = [
  {
    pattern: '**/prep/product/plans/**',
    fixture: 'fixtures/product-plans.json',
  },
  {
    pattern: '**/app/experiment/**',
    body: {
      code: 200,
      data: {
        assigned: true,
        variantId: 'A',
        experimentId: 'e2e-mock',
      },
    },
  },
  {
    pattern: '**/order/create/**',
    body: {
      code: 200,
      data: {
        orderNo: 'E2E-ORDER-001',
        skuId: 102,
        channels: {
          stripe: {
            clientSecret: 'seti_e2e_mock_secret',
            directive: 'CONFIRM_SETUP',
          },
        },
      },
    },
  },
];
