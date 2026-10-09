#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>

struct NetPcmOptions {
  /** DSD only: 44.1 kHz / 16-bit instead of ~88.2 kHz / 24-bit. */
  bool wifi = false;
  /** Gain on DSD converted to PCM: 0, 3 or 6 dB. */
  int dsdLevelDb = 3;
  /** DSD only: the DSD bits untouched as DoP in 24-bit PCM at DSD rate / 16 (DSD64 → 176.4 kHz). */
  bool dop = false;
};

/**
 * PCM a network player pulls as WAV: random access by frame, little-endian, interleaved.
 * DSD (DSF / DFF) is converted, or packed as DoP; every other format is decoded at its own
 * rate. Integer sources up to 16 bits stay 16-bit, everything else is 24-bit. Not thread-safe.
 */
class NetPcmSource {
public:
  virtual ~NetPcmSource() = default;
  virtual uint32_t sampleRate() const = 0;
  virtual uint16_t channels() const = 0;
  virtual uint64_t frameCount() const = 0;
  /** 16 or 24. */
  virtual uint16_t bitsPerSample() const = 0;
  /** Writes frames [startFrame, startFrame + count) to out; returns the frames written. */
  virtual size_t read(uint64_t startFrame, size_t count, uint8_t* out) = 0;
};

std::unique_ptr<NetPcmSource> openNetPcmSource(
    const std::string& path, const NetPcmOptions& options, std::string& error);
