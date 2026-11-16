#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <string>
#include <utility>
#include <vector>

struct FinalizeOptions {
  /** The take as captured (RawWavWriter). */
  std::string rawPath;
  /** Where the files go; must exist. */
  std::string outDir;
  /** Split PCM into tracks at silence of at least silenceSeconds below silenceDb. */
  bool split = false;
  double silenceDb = -70.0;
  double silenceSeconds = 2.0;
  /** Vorbis comments for every FLAC; TITLE and TRACKNUMBER are added per file. */
  std::vector<std::pair<std::string, std::string>> tags;
  /** Base of each TITLE: "<titleBase> <n>". */
  std::string titleBase = "Track";
};

struct FinalizedFile {
  std::string path;
  /** flac | dsf | spdif | wav */
  std::string kind;
  uint32_t sampleRate = 0;
  /** PCM bits (16 / 24 / 32); 1 for DSD; 16 for a bitstream. */
  int bits = 0;
  uint64_t frames = 0;
  double seconds = 0;
};

struct FinalizeResult {
  std::vector<FinalizedFile> files;
  /** Frames skipped as digital silence or too short to keep. */
  uint64_t skippedFrames = 0;
  uint64_t totalFrames = 0;
};

/**
 * Turns a raw take into the files the source sent: FLAC at the bit depth really used (16 or 24),
 * DSF for DoP, raw IEC 61937 (.spdif) for Dolby / DTS, each split where the content changes and,
 * if asked, at silence. Samples are never changed. `progress` runs 0…1.
 */
bool finalizeTake(const FinalizeOptions& options, FinalizeResult& result, std::string& error,
                  std::atomic<double>* progress = nullptr);
