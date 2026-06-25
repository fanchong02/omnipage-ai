import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type { DeviceConfig, EnvironmentConfig } from './types.js';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');

export const getRootDir = () => rootDir;

export const loadEnvironments = (): Record<string, EnvironmentConfig> => {
  const raw = readFileSync(join(rootDir, 'config/environments.yaml'), 'utf8');
  return parseYaml(raw) as Record<string, EnvironmentConfig>;
};

export const loadDevices = (): Record<string, DeviceConfig> => {
  const raw = readFileSync(join(rootDir, 'config/devices.yaml'), 'utf8');
  return parseYaml(raw) as Record<string, DeviceConfig>;
};

export const resolveEnvironment = (envName: string): EnvironmentConfig => {
  const envs = loadEnvironments();
  const env = envs[envName];
  if (!env) {
    throw new Error(`Unknown environment "${envName}". Available: ${Object.keys(envs).join(', ')}`);
  }
  const baseURL = process.env.E2E_BASE_URL?.trim() || env.baseURL;
  return { ...env, baseURL };
};

export const resolveDevice = (deviceName: string): DeviceConfig => {
  const devices = loadDevices();
  const device = devices[deviceName];
  if (!device) {
    throw new Error(`Unknown device "${deviceName}". Available: ${Object.keys(devices).join(', ')}`);
  }
  return device;
};

export const readFixtureJson = (fixturePath: string): unknown => {
  const fullPath = join(rootDir, fixturePath);
  return JSON.parse(readFileSync(fullPath, 'utf8'));
};
