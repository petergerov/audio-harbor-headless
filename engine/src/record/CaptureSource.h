#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

/** A digital input read bit-perfect: no conversion, no mixing, the exact rate or nothing. */
class CaptureSource {
public:
  virtual ~CaptureSource() = default;
  /** False (with error) if the device cannot run at exactly this rate and channel count. */
  virtual bool open(uint32_t rate, int channels, std::string& error) = 0;
  /**
   * Up to maxFrames, interleaved, left-justified 32-bit. Waits up to timeoutMs.
   * > 0 frames read; 0 nothing came (no signal / not locked); < 0 the device failed.
   */
  virtual long read(int32_t* out, size_t maxFrames, int timeoutMs) = 0;
  virtual void close() = 0;
  /** Bits the device delivers per sample (16, 24 or 32). */
  virtual int deviceBits() const = 0;
  /** Times the device's buffer ran over (samples lost before we could read them). */
  virtual uint64_t overruns() const = 0;
  virtual std::string lastError() const { return {}; }
};

/**
 * "file:<path.wav>" plays a WAV in as if it came in live (tests, demos); "filefast:<path>" does it
 * without waiting. Anything else is an ALSA device (Linux), e.g. hw:CARD=sndrpihifiberry,DEV=0.
 */
std::unique_ptr<CaptureSource> makeCaptureSource(const std::string& device);

struct CaptureDeviceInfo {
  std::string id;   // hw:CARD=<id>,DEV=<n>
  std::string name; // card and device name
};

/** Capture devices of the system (ALSA hw: devices on Linux; none elsewhere). */
std::vector<CaptureDeviceInfo> listCaptureDevices();

std::unique_ptr<CaptureSource> makeFileCapture(const std::string& path, bool realtime);
#if defined(__linux__)
std::unique_ptr<CaptureSource> makeAlsaCapture(const std::string& device);
#endif
