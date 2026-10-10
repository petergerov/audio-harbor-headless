import fs from 'node:fs';
import TOML from '@iarna/toml';
import type { AudioBackend, HarborConfig, NetworkDsdMode, NetworkStreamQuality, OutputMode } from './types.js';
import { configPath, exampleConfigPath } from './paths.js';

const DEFAULTS: HarborConfig = {
  server: {
    host: '0.0.0.0',
    port: 8787,
    name: 'Audio Harbor',
    local_hostname: 'audioharbor',
  },
  library: { roots: [] },
  output: {
    device_uid: null,
    device_name: null,
    mode: 'shared',
    dsd_pcm_level: 3,
    backend: 'auto',
    network_stream: 'full',
  },
  network: {
    media_port: 49153,
    dsd_modes: {},
  },
  sharing: {
    enabled: false,
    port: 8200,
    friendly_name: 'Audio Harbor Headless',
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
  // Legacy "juce" configs keep working as native (JUCE was removed).
  if (backend === 'native' || backend === 'juce') return 'native';
  if (backend === 'auto') return 'auto';
  return 'auto';
}

export function normalizeNetworkStream(value: unknown): NetworkStreamQuality {
  return value === 'wifi' ? 'wifi' : 'full';
}

export function normalizeNetworkDsd(value: unknown): NetworkDsdMode {
  return value === 'pcm' || value === 'dop' ? value : 'auto';
}

/** Player uid → mode; auto is the default and is not stored. */
function normalizeDsdModes(value: unknown): Record<string, NetworkDsdMode> {
  const modes: Record<string, NetworkDsdMode> = {};
  if (!value || typeof value !== 'object') return modes;
  for (const [uid, mode] of Object.entries(value as Record<string, unknown>)) {
    const normalized = normalizeNetworkDsd(mode);
    if (uid.startsWith('upnp:') && normalized !== 'auto') modes[uid] = normalized;
  }
  return modes;
}

function normalizePort(value: unknown, fallback: number): number {
  const port = Number(value);
  return Number.isInteger(port) && port >= 0 && port < 65536 ? port : fallback;
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
  const network = (parsed.network ?? {}) as Record<string, unknown>;

  return {
    server: {
      host: String(server.host ?? DEFAULTS.server.host),
      port: Number(server.port ?? DEFAULTS.server.port),
      name: String(server.name ?? DEFAULTS.server.name),
      local_hostname: String(server.local_hostname ?? DEFAULTS.server.local_hostname),
    },
    library: {
      roots: Array.isArray(library.roots)
        ? library.roots.map(String)
        : [...DEFAULTS.library.roots],
    },
    output: {
      device_uid: output.device_uid ? String(output.device_uid) : null,
      device_name: output.device_name ? String(output.device_name) : null,
      mode: normalizeMode(output.mode),
      dsd_pcm_level: normalizeLevel(output.dsd_pcm_level),
      backend: normalizeBackend(output.backend),
      network_stream: normalizeNetworkStream(output.network_stream),
    },
    network: {
      media_port: normalizePort(network.media_port, DEFAULTS.network.media_port),
      dsd_modes: normalizeDsdModes(network.dsd_modes),
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
      device_name: cfg.output.device_name ?? '',
      mode: cfg.output.mode,
      dsd_pcm_level: cfg.output.dsd_pcm_level,
      backend: cfg.output.backend,
      network_stream: cfg.output.network_stream,
    },
    network: cfg.network,
    sharing: cfg.sharing,
    remote: cfg.remote,
  });
  fs.writeFileSync(configPath(), body);
}
