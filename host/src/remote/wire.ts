import type { NowPlayingSnapshot, QueueSnapshot, Track } from '../types.js';

/** Deterministic UUID string from a 32-char hex catalogue id. */
export function toUuid(hexOrId: string): string {
  const h = hexOrId.replace(/-/g, '').toLowerCase().padEnd(32, '0').slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export function trackDto(track: Track | null | undefined): Record<string, unknown> | null {
  if (!track) return null;
  return {
    id: toUuid(track.id),
    cataloguePath: track.cataloguePath,
    title: track.title,
    artist: track.artist,
    album: track.album,
    trackNumber: track.trackNumber,
    year: track.year,
    duration: track.durationSecs ?? 0,
    format: track.format,
    sampleRateHz: track.sampleRate,
    bitDepth: track.bitDepth,
    channelCount: track.channels,
    artworkHash: track.artworkHash,
  };
}

/** Harbor iOS NowPlayingSnapshot wire shape. */
export function wireNowPlaying(snap: NowPlayingSnapshot, generation = 1): Record<string, unknown> {
  const rate = snap.state === 'playing' ? 1 : 0;
  return {
    generation,
    track: trackDto(snap.track),
    state: snap.state,
    position: snap.positionSecs,
    duration: snap.durationSecs ?? snap.track?.durationSecs ?? 0,
    positionTimestamp: new Date().toISOString(),
    rate,
    queueIndex: 0,
    queueCount: 0,
    queueSourceKind: 'library',
    queueSourceName: null,
    repeatMode: snap.repeat,
    isShuffled: snap.shuffle,
    activeFormatLabel: snap.conversionBadge,
    pathLabel: snap.output.effectiveMode,
    outputVolume: snap.volume,
    outputName: snap.output.devices.find((d) => d.uid === snap.output.selectedUid)?.name ?? null,
    playbackLocked: false,
  };
}

export function wireQueue(snap: QueueSnapshot, generation = 1): Record<string, unknown> {
  return {
    generation,
    index: snap.currentIndex ?? 0,
    tracks: snap.tracks.map((t) => trackDto(t)),
    sourceKind: 'library',
    sourceName: null,
  };
}
