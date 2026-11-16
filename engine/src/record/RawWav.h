#pragma once

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <string>

/**
 * The take while it is recorded: 32-bit PCM WAV (WAVE_FORMAT_EXTENSIBLE), samples left-justified
 * exactly as captured. Becomes RF64 past 4 GB. The header is brought up to date every few seconds,
 * so after a power cut the file is still a WAV the host can finish later.
 */
class RawWavWriter {
public:
  ~RawWavWriter();
  bool open(const std::string& path, uint32_t sampleRate, int channels, int validBits, std::string& error);
  bool write(const int32_t* interleaved, size_t frames);
  /** Sizes into the header and the data to disk. */
  bool sync();
  bool close();
  uint64_t frames() const { return frames_; }

private:
  bool writeHeader();
  FILE* file_ = nullptr;
  uint32_t rate_ = 0;
  int channels_ = 0;
  int validBits_ = 32;
  uint64_t frames_ = 0;
  bool failed_ = false;
};

/** A PCM WAV / RF64 (16, 24 or 32-bit integer) read as left-justified 32-bit samples. */
class WavReader {
public:
  ~WavReader();
  bool open(const std::string& path, std::string& error);
  void close();
  /** Reads up to `frames` from `start`; returns the frames read. */
  size_t read(uint64_t start, size_t frames, int32_t* out);
  uint32_t sampleRate() const { return rate_; }
  int channels() const { return channels_; }
  /** Bits the file says are valid (e.g. 24 in a 32-bit container). */
  int validBits() const { return validBits_; }
  uint64_t frames() const { return frames_; }

private:
  FILE* file_ = nullptr;
  uint32_t rate_ = 0;
  int channels_ = 0;
  int containerBits_ = 0;
  int validBits_ = 0;
  uint64_t dataOffset_ = 0;
  uint64_t frames_ = 0;
  std::string buffer_;
};
