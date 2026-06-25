export const resolveHeadless = (explicit?: boolean): boolean => {
  if (explicit !== undefined) return explicit;
  if (process.env.HEADLESS === 'true') return true;
  if (process.env.HEADLESS === 'false') return false;
  if (process.env.CI) return true;
  return false;
};

export const resolveSlowMo = (headless: boolean): number => {
  const raw = process.env.QA_SLOW_MO?.trim();
  if (raw) {
    const value = Number(raw);
    return Number.isFinite(value) ? value : 0;
  }
  return headless ? 0 : 300;
};

export const resolveShowProgress = (headless: boolean, flag?: string): boolean => {
  if (flag === 'false' || flag === '0') return false;
  if (flag === 'true' || flag === '1') return true;
  return !headless;
};

export type OpenReportMode = false | true | 'each';

export const resolveOpenReport = (headless: boolean, flag?: string): OpenReportMode => {
  if (flag === 'false' || flag === '0') return false;
  if (flag === 'each') return 'each';
  if (flag === 'true' || flag === '1') return true;
  if (process.env.OPEN_REPORT === 'false') return false;
  if (process.env.OPEN_REPORT === 'each') return 'each';
  if (process.env.CI || headless) return false;
  return true;
};

export const resolveVisualReview = (flag?: string): boolean => {
  if (flag === 'true' || flag === '1') return true;
  if (flag === 'false' || flag === '0') return false;
  return process.env.VISUAL_REVIEW === 'true';
};
