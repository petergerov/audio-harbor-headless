#pragma once

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <string>
#include <utility>
#include <vector>

#include "Md5.h"

/**
 * A small lossless FLAC encoder for recordings: fixed predictors (order 0–4), partitioned Rice
 * residuals, constant subframes for digital silence, and the best of the four stereo modes per
 * block. No libFLAC needed. The STREAMINFO carries the MD5 of the audio, so `flac -t` proves the
 * file decodes to exactly the samples that went in.
 */
class FlacEncoder {
public:
  using Tags = std::vector<std::pair<std::string, std::string>>;

  ~FlacEncoder();

  /** bits: 16 or 24 (4–24 work). channels: 1–8. */
  bool open(const std::string& path, uint32_t sampleRate, int channels, int bits, const Tags& tags,
            std::string& error);
  /** Interleaved samples, right-justified: each within the signed range of `bits`. */
  bool write(const int32_t* interleaved, size_t frames);
  /** The last block, then STREAMINFO with the length and MD5. False on a write error. */
  bool close();

  uint64_t frames() const { return totalFrames_; }

  static constexpr uint32_t kBlockSize = 4096;

private:
  bool encodeBlock(uint32_t n);
  bool writeHeaderBlocks(bool final);

  FILE* file_ = nullptr;
  std::string path_;
  uint32_t rate_ = 0;
  int channels_ = 0;
  int bits_ = 0;
  Tags tags_;
  std::vector<std::vector<int32_t>> block_;
  uint32_t fill_ = 0;
  uint64_t frameNumber_ = 0;
  uint64_t totalFrames_ = 0;
  uint32_t minFrameBytes_ = 0;
  uint32_t maxFrameBytes_ = 0;
  Md5 md5_;
  std::vector<uint8_t> md5Bytes_;
  bool failed_ = false;
};
