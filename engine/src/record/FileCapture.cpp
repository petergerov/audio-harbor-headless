#include "CaptureSource.h"

#include <algorithm>
#include <chrono>
#include <thread>

#include "RawWav.h"

namespace {

/** A WAV fed in as if from a digital input; at its end the "signal" goes away. */
class FileCapture : public CaptureSource {
public:
  FileCapture(std::string path, bool realtime) : path_(std::move(path)), realtime_(realtime) {}

  bool open(uint32_t rate, int channels, std::string& error) override {
    if (!reader_.open(path_, error)) return false;
    if (reader_.sampleRate() != rate) {
      error = "Input runs at " + std::to_string(reader_.sampleRate()) + " Hz, not " + std::to_string(rate) + " Hz";
      return false;
    }
    if (reader_.channels() != channels) {
      error = "Input has " + std::to_string(reader_.channels()) + " channels";
      return false;
    }
    rate_ = rate;
    started_ = std::chrono::steady_clock::now();
    return true;
  }

  long read(int32_t* out, size_t maxFrames, int timeoutMs) override {
    if (pos_ >= reader_.frames()) {
      std::this_thread::sleep_for(std::chrono::milliseconds(timeoutMs));
      return 0;
    }
    size_t want = maxFrames;
    if (realtime_) {
      for (;;) {
        const double elapsed = std::chrono::duration<double>(std::chrono::steady_clock::now() - started_).count();
        const uint64_t due = uint64_t(elapsed * rate_);
        if (due > pos_) {
          want = size_t(std::min<uint64_t>(maxFrames, due - pos_));
          break;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
      }
    }
    const size_t got = reader_.read(pos_, want, out);
    pos_ += got;
    return long(got);
  }

  void close() override { reader_.close(); }
  int deviceBits() const override { return reader_.validBits(); }
  uint64_t overruns() const override { return 0; }

private:
  std::string path_;
  bool realtime_;
  WavReader reader_;
  uint32_t rate_ = 0;
  uint64_t pos_ = 0;
  std::chrono::steady_clock::time_point started_;
};

} // namespace

std::unique_ptr<CaptureSource> makeFileCapture(const std::string& path, bool realtime) {
  return std::make_unique<FileCapture>(path, realtime);
}

std::unique_ptr<CaptureSource> makeCaptureSource(const std::string& device) {
  if (device.rfind("file:", 0) == 0) return makeFileCapture(device.substr(5), true);
  if (device.rfind("filefast:", 0) == 0) return makeFileCapture(device.substr(9), false);
#if defined(__linux__)
  return makeAlsaCapture(device);
#elif defined(__APPLE__)
  return makeMacCapture(device);
#else
  return nullptr;
#endif
}

#if defined(__APPLE__)
int macAudioInputAccess();
int captureAccess() { return macAudioInputAccess(); }
#else
int captureAccess() { return 1; }
#endif

#if !defined(__linux__) && !defined(__APPLE__)
std::vector<CaptureDeviceInfo> listCaptureDevices() { return {}; }
#endif
