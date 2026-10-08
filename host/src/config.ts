import fs from 'node:fs';
import TOML from '@iarna/toml';
import type { AudioBackend, HarborConfig, OutputMode } from './types.js';
import { configPath, exampleConfigPath } from './paths.js';

const DEFAULTS: HarborConfig = {
  server: {
    host: '0.0.0.0',
    port: 8787,
    name: 'Audio Harbor',
  },
  library: { roots: [] },
  output: {
    device_uid: null,
    mode: 'shared',
    dsd_pcm_level: 3,
    backend: 'auto',
  },
  sharing: {
    enabled: false,
    port: 8200,
    friendly_name: 'Audio Harbor',
  },
  remote: {
    bonjour_enabled: true,
    bonjour_port: 8788,
  },
};

function normalizeMode(mode: unknown): OutputMode {
  if (mode === 'exclusive' || mode === 'dop' || mode === 'shared') return mode;
  return 'shared';
}

function normalizeLevel(level: unknown): 0 | 3 | 6 {
  if (level === 0 || level === 3 || level === 6) return level;
  return 3;
}

function normalizeBackend(backend: unknown): AudioBackend {
  if (backend === 'juce' || backend === 'native' || backend === 'auto') return backend;
  return 'auto';
}

export function loadConfig(): HarborConfig {
  const dest = configPath();
  if (!fs.existsSync(dest)) {
    const example = exampleConfigPath();
    if (fs.existsSync(example)) {
      fs.copyFileSync(example, dest);
    } else {
      saveConfig(DEFAULTS);
    }
  }
  const raw = fs.readFileSync(dest, 'utf8');
  const parsed = TOML.parse(raw) as Record<string, unknown>;
  const server = (parsed.server ?? {}) as Record<string, unknown>;
  const library = (parsed.library ?? {}) as Record<string, unknown>;
  const output = (parsed.output ?? {}) as Record<string, unknown>;
  const sharing = (parsed.sharing ?? {}) as Record<string, unknown>;
  const remote = (parsed.remote ?? {}) as Record<string, unknown>;

  return {
    server: {
      host: String(server.host ?? DEFAULTS.server.host),
      port: Number(server.port ?? DEFAULTS.server.port),
      name: String(server.name ?? DEFAULTS.server.name),
    },
    library: {
      roots: Array.isArray(library.roots)
        ? library.roots.map(String)
        : [...DEFAULTS.library.roots],
    },
    output: {
      device_uid: output.device_uid ? String(output.device_uid) : null,
      mode: normalizeMode(output.mode),
      dsd_pcm_level: normalizeLevel(output.dsd_pcm_level),
      backend: normalizeBackend(output.backend),
    },
    sharing: {
      enabled: Boolean(sharing.enabled ?? DEFAULTS.sharing.enabled),
      port: Number(sharing.port ?? DEFAULTS.sharing.port),
      friendly_name: String(sharing.friendly_name ?? DEFAULTS.sharing.friendly_name),
    },
    remote: {
      bonjour_enabled: Boolean(remote.bonjour_enabled ?? DEFAULTS.remote.bonjour_enabled),
      bonjour_port: Number(remote.bonjour_port ?? DEFAULTS.remote.bonjour_port),
    },
  };
}

export function saveConfig(cfg: HarborConfig): void {
  const body = TOML.stringify({
    server: cfg.server,
    library: cfg.library,
    output: {
      device_uid: cfg.output.device_uid ?? '',
      mode: cfg.output.mode,
      dsd_pcm_level: cfg.output.dsd_pcm_level,
      backend: cfg.output.backend,
    },
    sharing: cfg.sharing,
    remote: cfg.remote,
  });
  fs.writeFileSync(configPath(), body);
}
