import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { gotoWithAuth } from '../auth/navigate-with-auth.js';
import { isAuthTestPath } from '../auth/auto-login.js';
import {
  formatExploreSummary,
  runPageExplore,
  type ExploreOptions,
  type ExploreReport,
} from './page-explorer.js';
import { writeExploreHtmlReport } from '../reporters/explore-html-report.js';

export type SiteExploreOptions = ExploreOptions & {
  seedUrl: string;
  maxPages?: number;
  onPageStart?: (index: number, total: number, url: string, label?: string) => void;
  onPageDone?: (index: number, url: string, report: ExploreReport) => void;
};

export type SitePageResult = {
  url: string;
  label?: string;
  report: ExploreReport;
  reportDir: string;
};

export type SiteExploreReport = {
  seedUrl: string;
  pages: SitePageResult[];
  visitedUrls: string[];
  skippedUrls: string[];
};

const SKIP_NAV_PATH =
  /\/login(?:[/?#]|$)|logout|log-out|signout|sign-out|register|signup|forgot-password|manage-password/i;
const SKIP_NAV_LABEL =
  /logout|log out|sign out|登出|退出登录|注销|delete account|支付|purchase|checkout|@[a-z0-9.-]+\.[a-z]{2,}/i;
const DOWNLOAD_EXT = /\.(pdf|zip|png|jpe?g|gif|svg|mp4|docx?|xlsx?|csv)(\?|$)/i;

const DISCOVER_NAV_LINKS_SCRIPT = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'discover-nav-links.browser.js'),
  'utf8'
);

/** 用于去重的 URL 键（同源 SPA 保留 hash） */
export const normalizeExploreUrl = (raw: string, baseUrl: string): string | null => {
  try {
    const base = new URL(baseUrl);
    const u = new URL(raw, baseUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.origin !== base.origin) return null;

    const useHash = Boolean(base.hash) || Boolean(u.hash);
    if (useHash) {
      const hash = u.hash || '#/';
      return `${u.origin}${u.pathname}${u.search}${hash}`;
    }
    return `${u.origin}${u.pathname}${u.search}`;
  } catch {
    return null;
  }
};

export const shouldSkipNavTarget = (url: string, label: string, currentUrl: string): boolean => {
  const normalized = normalizeExploreUrl(url, currentUrl);
  if (!normalized) return true;
  if (normalized === normalizeExploreUrl(currentUrl, currentUrl)) return true;
  if (SKIP_NAV_PATH.test(url) || SKIP_NAV_PATH.test(normalized)) return true;
  if (SKIP_NAV_LABEL.test(label)) return true;
  if (DOWNLOAD_EXT.test(url)) return true;
  if (isAuthTestPath(url)) return true;
  return false;
};

type NavCandidate =
  | { kind: 'url'; url: string; label: string; priority: number }
  | { kind: 'click'; label: string; fromUrl: string; priority: number };

type QueueItem = NavCandidate;

const clickNavKey = (fromUrl: string, label: string) =>
  `click:${normalizeExploreUrl(fromUrl, fromUrl) ?? fromUrl}::${label.trim().toLowerCase()}`;

const MENU_BUTTON_PATTERN = /menu|hamburger|导航|更多|sidebar|drawer|目录/i;

/** 尝试展开侧栏 / 汉堡菜单，以便发现隐藏导航链接 */
const revealHiddenNavigation = async (page: Page) => {
  const candidates = [
    page.getByRole('button', { name: MENU_BUTTON_PATTERN }),
    page.locator('[aria-label*="menu" i], [aria-label*="Menu"], [class*="hamburger"], [class*="menu-btn"]'),
  ];

  for (const locator of candidates) {
    const target = locator.first();
    const visible = await target.isVisible({ timeout: 400 }).catch(() => false);
    if (!visible) continue;
    await target.click({ timeout: 3000 }).catch(() => undefined);
    await page.waitForTimeout(600);
    return;
  }
};

const collectNavCandidates = async (page: Page, scopeUrl: string) => {
  await revealHiddenNavigation(page);
  return discoverInternalNavLinks(page, scopeUrl);
};

const ensureOnPage = async (
  page: Page,
  pageKey: string,
  options: SiteExploreOptions
) => {
  const current = normalizeExploreUrl(page.url(), options.seedUrl);
  if (current === pageKey) return;
  await gotoWithAuth(page, pageKey, {
    envName: options.envName ?? 'default',
    account: options.account,
    disabled: options.authDisabled,
  });
};

export const discoverInternalNavLinks = async (
  page: Page,
  scopeUrl: string
): Promise<NavCandidate[]> => {
  const currentKey = normalizeExploreUrl(scopeUrl, scopeUrl) ?? page.url();

  const raw = await page.evaluate(DISCOVER_NAV_LINKS_SCRIPT);

  const candidates: NavCandidate[] = [];
  for (const item of raw) {
    if (item.clickOnly) {
      if (SKIP_NAV_LABEL.test(item.label)) continue;
      candidates.push({
        kind: 'click',
        label: item.label,
        fromUrl: currentKey,
        priority: item.inNav ? 0 : 1,
      });
      continue;
    }

    const absolute = normalizeExploreUrl(item.href, scopeUrl);
    if (!absolute) continue;
    if (shouldSkipNavTarget(absolute, item.label, scopeUrl)) continue;
    candidates.push({
      kind: 'url',
      url: absolute,
      label: item.label,
      priority: item.inNav ? 0 : 1,
    });
  }

  candidates.sort((a, b) => a.priority - b.priority || a.label.localeCompare(b.label));
  return candidates;
};

const enqueueUnique = (
  queue: QueueItem[],
  visitedUrls: Set<string>,
  visitedClicks: Set<string>,
  items: NavCandidate[]
): number => {
  const before = queue.length;
  for (const item of items) {
    if (item.kind === 'url') {
      const key = normalizeExploreUrl(item.url, item.url);
      if (!key || visitedUrls.has(key)) continue;
      if (queue.some(q => q.kind === 'url' && normalizeExploreUrl(q.url, q.url) === key)) continue;
      queue.push(item);
      continue;
    }

    const key = clickNavKey(item.fromUrl, item.label);
    if (visitedClicks.has(key)) continue;
    if (queue.some(q => q.kind === 'click' && clickNavKey(q.fromUrl, q.label) === key)) continue;
    queue.push(item);
  }
  return queue.length - before;
};

const navigateToPage = async (
  page: Page,
  item: QueueItem,
  options: SiteExploreOptions
): Promise<string | null> => {
  if (item.kind === 'url') {
    await gotoWithAuth(page, item.url, {
      envName: options.envName ?? 'default',
      account: options.account,
      disabled: options.authDisabled,
    });
    return normalizeExploreUrl(page.url(), options.seedUrl);
  }

  const fromKey = normalizeExploreUrl(item.fromUrl, options.seedUrl);
  const currentKey = normalizeExploreUrl(page.url(), options.seedUrl);
  if (fromKey && currentKey !== fromKey) {
    await gotoWithAuth(page, item.fromUrl, {
      envName: options.envName ?? 'default',
      account: options.account,
      disabled: options.authDisabled,
    });
  }

  const locator = page
    .getByRole('link', { name: item.label, exact: false })
    .or(page.getByRole('menuitem', { name: item.label, exact: false }))
    .or(page.getByRole('tab', { name: item.label, exact: false }))
    .or(page.getByText(item.label, { exact: false }));

  await locator.first().click({ timeout: 10_000 });
  await page.waitForLoadState('domcontentloaded').catch(() => undefined);
  await page.waitForTimeout(800);
  return normalizeExploreUrl(page.url(), options.seedUrl);
};

export const runSiteExplore = async (
  page: Page,
  options: SiteExploreOptions
): Promise<SiteExploreReport> => {
  const maxPages = options.maxPages ?? 30;
  const seedKey = normalizeExploreUrl(options.seedUrl, options.seedUrl);
  if (!seedKey) throw new Error(`无效的起始 URL: ${options.seedUrl}`);

  const visitedUrls = new Set<string>();
  const visitedClicks = new Set<string>();
  const skippedUrls: string[] = [];
  const queue: QueueItem[] = [{ kind: 'url', url: seedKey, label: '起始页', priority: 0 }];
  const pages: SitePageResult[] = [];

  while (queue.length > 0 && pages.length < maxPages) {
    const next = queue.shift()!;

    if (next.kind === 'click') {
      visitedClicks.add(clickNavKey(next.fromUrl, next.label));
    }

    const pageIndex = pages.length + 1;
    const pageReportDir = options.reportDir
      ? join(options.reportDir, `page-${String(pageIndex).padStart(2, '0')}`)
      : undefined;
    if (pageReportDir) mkdirSync(pageReportDir, { recursive: true });

    options.onPageStart?.(
      pageIndex,
      maxPages,
      next.kind === 'url' ? next.url : next.fromUrl,
      next.label
    );
    console.log(`\n📄 [${pageIndex}/${maxPages}] 探索页面入口: ${next.label}`);
    if (next.kind === 'click') {
      console.log(`   导航: 从 ${next.fromUrl} 点击「${next.label}」`);
    } else {
      console.log(`   URL: ${next.url}`);
    }

    const pageKey = await navigateToPage(page, next, options);
    if (!pageKey) continue;
    if (visitedUrls.has(pageKey)) {
      console.log(`   ↳ 跳过：页面已测试 ${pageKey}`);
      continue;
    }
    visitedUrls.add(pageKey);

    const preDiscover = await collectNavCandidates(page, pageKey);
    const preAdded = enqueueUnique(queue, visitedUrls, visitedClicks, preDiscover);
    if (preAdded > 0) {
      console.log(`   🔗 入队前发现 ${preAdded} 个页面入口，队列 ${queue.length} 个`);
    }

    const report = await runPageExplore(page, {
      ...options,
      reportDir: pageReportDir,
      navigateBack: true,
      siteCrawl: true,
    });

    await ensureOnPage(page, pageKey, options);

    pages.push({ url: pageKey, label: next.label, report, reportDir: pageReportDir ?? '' });
    options.onPageDone?.(pageIndex, pageKey, report);
    console.log(`   ↳ ${formatExploreSummary(report)}`);

    const discovered = await collectNavCandidates(page, pageKey);
    const added = enqueueUnique(queue, visitedUrls, visitedClicks, discovered);
    if (added > 0) {
      console.log(`   🔗 发现 ${added} 个待测页面入口，队列剩余 ${queue.length} 个`);
    } else if (queue.length === 0) {
      console.log(`   ✓ 无更多站内页面入口`);
    }
  }

  if (queue.length > 0 && pages.length >= maxPages) {
    for (const item of queue) {
      if (item.kind === 'url') {
        const key = normalizeExploreUrl(item.url, options.seedUrl);
        if (key && !visitedUrls.has(key)) skippedUrls.push(key);
      } else {
        skippedUrls.push(`${item.fromUrl} → ${item.label}`);
      }
    }
    console.log(
      `\n⚠ 已达 maxPages=${maxPages}，尚有 ${skippedUrls.length} 个入口未测试（可提高 --max-pages）`
    );
  }

  if (options.reportDir) {
    writeSiteExploreIndex(options.reportDir, {
      seedUrl: options.seedUrl,
      pages,
      visitedUrls: [...visitedUrls],
      skippedUrls,
    });
  }

  return { seedUrl: options.seedUrl, pages, visitedUrls: [...visitedUrls], skippedUrls };
};

export const formatSiteExploreSummary = (report: SiteExploreReport): string => {
  const totalAttempted = report.pages.reduce((n, p) => n + p.report.attempted, 0);
  const totalSucceeded = report.pages.reduce((n, p) => n + p.report.succeeded, 0);
  return (
    `全站探索完成：共测试 ${report.pages.length} 个页面，` +
    `合计尝试 ${totalAttempted} 次，成功 ${totalSucceeded} 次` +
    (report.skippedUrls.length ? `，未测 ${report.skippedUrls.length} 个（超出 maxPages）` : '')
  );
};

const writeSiteExploreIndex = (reportDir: string, report: SiteExploreReport) => {
  writeFileSync(
    join(reportDir, 'site-explore.json'),
    JSON.stringify(
      {
        seedUrl: report.seedUrl,
        pageCount: report.pages.length,
        visitedUrls: report.visitedUrls,
        skippedUrls: report.skippedUrls,
        pages: report.pages.map(p => ({
          url: p.url,
          label: p.label,
          reportDir: p.reportDir,
          summary: formatExploreSummary(p.report),
        })),
      },
      null,
      2
    )
  );

  const pageRows = report.pages
    .map(
      (p, i) =>
        `<tr>
          <td>${i + 1}</td>
          <td><a href="./page-${String(i + 1).padStart(2, '0')}/index.html">${p.url}</a></td>
          <td>${p.label ?? ''}</td>
          <td>${p.report.attempted}</td>
          <td>${p.report.succeeded}</td>
        </tr>`
    )
    .join('\n');

  writeFileSync(
    join(reportDir, 'index.html'),
    `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>全站探索报告</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 24px; background: #f8fafc; color: #0f172a; }
    table { border-collapse: collapse; width: 100%; background: #fff; }
    th, td { border: 1px solid #e2e8f0; padding: 10px 12px; text-align: left; font-size: 14px; }
    th { background: #f1f5f9; }
    a { color: #2563eb; word-break: break-all; }
  </style>
</head>
<body>
  <h1>全站探索报告</h1>
  <p>起始 URL: <a href="${report.seedUrl}">${report.seedUrl}</a></p>
  <p>已测 ${report.pages.length} 页${report.skippedUrls.length ? `，未测 ${report.skippedUrls.length} 页（maxPages 限制）` : ''}</p>
  <table>
    <thead><tr><th>#</th><th>URL</th><th>入口</th><th>尝试</th><th>成功</th></tr></thead>
    <tbody>${pageRows}</tbody>
  </table>
</body>
</html>`
  );

  for (const p of report.pages) {
    if (p.reportDir) {
      writeExploreHtmlReport(p.report, p.reportDir, {
        title: `探索 — ${p.url}`,
        url: p.url,
      });
    }
  }
};
