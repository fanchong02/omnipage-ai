import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

export type PagePlatform = 'h5' | 'web';

export const PLATFORM_LABEL: Record<PagePlatform, string> = {
  h5: 'H5 手机小屏 (390×844)',
  web: 'Web 桌面大屏 (1280×720)',
};

export const platformToDevice = (platform: PagePlatform): 'mobile' | 'desktop' =>
  platform === 'web' ? 'desktop' : 'mobile';

export const parsePlatform = (raw: string): PagePlatform => {
  const v = raw.trim().toLowerCase();
  if (v === 'web' || v === 'desktop' || v === 'pc') return 'web';
  if (v === 'h5' || v === 'mobile' || v === 'm' || v === 'wap') return 'h5';
  throw new Error(`未知页面类型 "${raw}"，请使用 h5 或 web`);
};

export const resolveDeviceFromFlags = (
  flags: { device?: string; platform?: string },
  fallback: PagePlatform = 'h5'
): string => {
  if (flags.device?.trim()) return flags.device.trim();
  if (flags.platform?.trim()) return platformToDevice(parsePlatform(flags.platform));
  return platformToDevice(fallback);
};

export const resolvePlatform = async (
  platformFlag: string | undefined,
  prompt = true
): Promise<PagePlatform> => {
  if (platformFlag?.trim()) return parsePlatform(platformFlag);
  if (!prompt) return 'h5';

  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question('页面类型 (h5=手机小屏 / web=桌面大屏) [h5]: ');
    if (!answer.trim()) return 'h5';
    return parsePlatform(answer);
  } finally {
    rl.close();
  }
};

/** --device 优先；否则 --platform 或交互选择，映射到 config/devices.yaml 中的设备名 */
export const resolveSessionDevice = async (
  flags: { device?: string; platform?: string },
  options: { prompt?: boolean } = {}
): Promise<{ deviceName: string; platform: PagePlatform }> => {
  if (flags.device?.trim()) {
    const deviceName = flags.device.trim();
    const platform: PagePlatform =
      deviceName === 'desktop'
        ? 'web'
        : flags.platform?.trim()
          ? parsePlatform(flags.platform)
          : 'h5';
    return { deviceName, platform };
  }

  const shouldPrompt = options.prompt ?? !flags.platform;
  const platform = await resolvePlatform(flags.platform, shouldPrompt);
  return { deviceName: platformToDevice(platform), platform };
};

export const formatPlatformLine = (platform: PagePlatform, deviceName: string) =>
  `页面类型: ${PLATFORM_LABEL[platform]} → device=${deviceName}`;
