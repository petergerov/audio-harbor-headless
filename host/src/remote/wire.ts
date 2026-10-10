import type { AudioFormat, NowPlayingSnapshot, OutputMode, QueueSnapshot, Track } from '../types.js';

/** Deterministic UUID string from a 32-char hex catalogue id. */
export function toUuid(hexOrId: string): string {
  const h = hexOrId.replace(/-/g, '').toLowerCase().padEnd(32, '0').slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** A playlist's id as the app's UUID (playlists made here already have one). */
export function wirePlaylistId(id: string): string {
  return id.includes('-') ? id : toUuid(id);
}

/** The Mac's `AudioFormat` raw values — the app's format badge. */
function wireFormat(format: AudioFormat): string {
  return format === 'unknown' ? '?' : format.toUpperCase();
}

const PATH_LABELS: Record<OutputMode, string> = { shared: 'Shared', exclusive: 'Exclusive', dop: 'DoP' };

/** Swift decodes dates as ISO 8601 without fractional seconds. */
function wireDate(date = new Date()): string {
  return date.toISOString().replace(/\.\d+Z$/, 'Z');
}

/** Harbor TrackDTO: never the artwork bytes; the catalogue path is the track's identity. */
export function trackDto(track: Track): Record<string, unknown> {
  return {
    id: toUuid(track.id),
    cataloguePath: track.cataloguePath,
    title: track.title,
    artist: track.artist,
    album: track.album,
    trackNumber: track.trackNumber,
    year: track.year,
    duration: track.durationSecs ?? 0,
    format: wireFormat(track.format),
    sampleRateHz: track.sampleRate,
    bitDepth: track.bitDepth,
    channelCount: track.channels,
    artworkHash: track.artworkHash,
  };
}

/** Harbor iOS NowPlayingSnapshot wire shape. */
export function wireNowPlaying(snap: NowPlayingSnapshot, generation = 1): Record<string, unknown> {
  const rate = snap.state === 'playing' ? 1 : 0;
  // Network player: the path is the stream ("DSD→PCM · Network"); the format badge stays the file's.
  const network = snap.output.selectedKind === 'network';
  return {
    generation,
    track: snap.track ? trackDto(snap.track) : null,
    state: snap.state === 'failed' && snap.error ? `failed:${snap.error}` : snap.state,
    position: snap.positionSecs,
    duration: snap.durationSecs ?? snap.track?.durationSecs ?? 0,
    positionTimestamp: wireDate(),
    rate,
    queueIndex: snap.queueIndex ?? 0,
    queueCount: snap.queueCount,
    queueSourceKind: snap.queueSource.kind,
    queueSourceName: snap.queueSource.name,
    repeatMode: snap.repeat,
    isShuffled: snap.shuffle,
    activeFormatLabel: network ? null : snap.conversionBadge,
    pathLabel: network
      ? (snap.conversionBadge ?? 'Network')
      : (PATH_LABELS[snap.output.effectiveMode] ?? PATH_LABELS.shared),
    outputVolume: snap.volume,
    outputName: snap.output.selectedName,
    playbackLocked: false,
  };
}

export function wireQueue(snap: QueueSnapshot, generation = 1): Record<string, unknown> {
  return {
    generation,
    index: snap.currentIndex ?? 0,
    tracks: snap.tracks.map(trackDto),
    sourceKind: snap.source.kind,
    sourceName: snap.source.name,
  };
}
