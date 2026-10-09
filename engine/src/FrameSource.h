#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>

struct FrameSourceOptions {
  /** DSD as PCM at 44.1 kHz / 16-bit instead of ~88.2 kHz / 24-bit (network Wi‑Fi stream). */
  bool wifi = false;
  /** Gain on DSD converted to PCM: 0, 3 or 6 dB. */
  int dsdLevelDb = 3;
  /** DSD only: the DSD bits untouched as DoP at DSD rate / 16 (DSD64 → 176.4 kHz). */
  bool dop = false;
};

/**
 * The audio of one file with random access by frame, interleaved: what a local player plays and
 * what a network player pulls as WAV. DSD (DSF / DFF) is converted to PCM or packed as DoP;
 * every other format is decoded at its own rate. Not thread-safe.
 */
class FrameSource {
public:
  virtual ~FrameSource() = default;
  virtual uint32_t sampleRate() const = 0;
  virtual uint16_t channels() const = 0;
  virtual uint64_t frameCount() const = 0;
  /** The depth worth sending: 16 for integer sources up to 16 bits, else 24 (DoP too). */
  virtual uint16_t bitsPerSample() const = 0;
  /** DoP: frames come from readDop(), not readFloat(). */
  virtual bool isDop() const { return false; }
  /** PCM as float, full scale ±1, into out. Returns the frames written; 0 for DoP. */
  virtual size_t readFloat(uint64_t startFrame, size_t count, float* out) = 0;
  /**
   * DoP words: marker in bits 31–24, the older DSD byte in 23–16, the newer one in 15–8, the low
   * byte 0. Returns the frames written; 0 for PCM.
   */
  virtual size_t readDop(uint64_t startFrame, size_t count, int32_t* out) {
    (void)startFrame;
    (void)count;
    (void)out;
    return 0;
  }
  /** Little-endian 16- or 24-bit samples (bitsPerSample) for a WAV body. Returns the frames written. */
  virtual size_t readPacked(uint64_t startFrame, size_t count, uint8_t* out) = 0;
};

std::unique_ptr<FrameSource> openFrameSource(
    const std::string& path, const FrameSourceOptions& options, std::string& error);
