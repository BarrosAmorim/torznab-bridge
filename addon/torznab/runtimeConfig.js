import fs from 'fs';
import path from 'path';
import { parseConfiguration } from '../lib/configuration.js';
import { Providers } from '../lib/filter.js';
import { getDefaultSources, normalizeSources, SOURCE_OPTIONS } from './source.js';

const CONFIG_PATH = process.env.TORZNAB_RUNTIME_CONFIG_PATH || '/config/torznab-ui.json';
const DEFAULT_CONFIGURATION = process.env.TORZNAB_CONFIGURATION || 'brazuca';
const VALID_PROVIDER_KEYS = new Set(Providers.options.map(provider => provider.key.toLowerCase()));
const VALID_SOURCE_KEYS = new Set(SOURCE_OPTIONS.map(source => source.key.toLowerCase()));

export function getRuntimeConfigPath() {
  return CONFIG_PATH;
}

export function getAdapterConfiguration() {
  const baseConfig = parseConfiguration(DEFAULT_CONFIGURATION) || {};
  const runtimeConfig = readRuntimeConfig();
  return {
    ...baseConfig,
    providers: runtimeConfig.configured ? runtimeConfig.providers : baseConfig.providers,
    sources: runtimeConfig.configured ? runtimeConfig.sources : getDefaultSources(),
  };
}

export function getSavedProviders() {
  return readRuntimeConfig().providers || [];
}

export function getSavedSources() {
  return readRuntimeConfig().sources || [];
}

export function saveRuntimeConfig({ providers = [], sources = [] } = {}) {
  const normalizedProviders = normalizeProviders(providers);
  const normalizedSources = normalizeRuntimeSources(sources);
  const payload = {
    providers: normalizedProviders,
    sources: normalizedSources,
    savedAt: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

function readRuntimeConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      return {};
    }

    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return {
      configured: true,
      providers: normalizeProviders(parsed.providers),
      sources: normalizeRuntimeSources(parsed.sources),
    };
  } catch (error) {
    console.error('Failed to read runtime config', error);
    return {};
  }
}

function normalizeProviders(providers) {
  if (!Array.isArray(providers)) {
    return [];
  }

  return Array.from(new Set(
      providers
          .map(provider => `${provider || ''}`.trim().toLowerCase())
          .filter(provider => VALID_PROVIDER_KEYS.has(provider)),
  ));
}

function normalizeRuntimeSources(sources) {
  return normalizeSources(sources)
      .filter(source => VALID_SOURCE_KEYS.has(source));
}
