#if defined(__APPLE__)

#include "CaptureSource.h"

#include <CoreAudio/CoreAudio.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <thread>
#include <vector>

/** Microphone access for this process (MacPermission.mm): 1 granted, 0 not asked yet, -1 denied. */
int macAudioInputAccess();

namespace {

AudioObjectPropertyAddress prop(AudioObjectPropertySelector selector,
                                AudioObjectPropertyScope scope = kAudioObjectPropertyScopeGlobal) {
  return {selector, scope, kAudioObjectPropertyElementMain};
}

std::string cfString(CFStringRef s) {
  if (!s) return {};
  char buf[512] = {};
  CFStringGetCString(s, buf, sizeof(buf), kCFStringEncodingUTF8);
  return buf;
}

std::string stringProperty(AudioObjectID id, AudioObjectPropertySelector selector) {
  CFStringRef value = nullptr;
  UInt32 size = sizeof(value);
  auto addr = prop(selector);
  if (AudioObjectGetPropertyData(id, &addr, 0, nullptr, &size, &value) != noErr || !value) return {};
  std::string out = cfString(value);
  CFRelease(value);
  return out;
}

std::vector<AudioDeviceID> allDevices() {
  auto addr = prop(kAudioHardwarePropertyDevices);
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &addr, 0, nullptr, &size) != noErr) return {};
  std::vector<AudioDeviceID> ids(size / sizeof(AudioDeviceID));
  if (!ids.empty()) AudioObjectGetPropertyData(kAudioObjectSystemObject, &addr, 0, nullptr, &size, ids.data());
  return ids;
}

/** Input channels of a device (all its input streams). */
int inputChannels(AudioDeviceID id) {
  auto addr = prop(kAudioDevicePropertyStreamConfiguration, kAudioObjectPropertyScopeInput);
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(id, &addr, 0, nullptr, &size) != noErr || size == 0) return 0;
  std::vector<uint8_t> buf(size);
  auto* list = reinterpret_cast<AudioBufferList*>(buf.data());
  if (AudioObjectGetPropertyData(id, &addr, 0, nullptr, &size, list) != noErr) return 0;
  int channels = 0;
  for (UInt32 i = 0; i < list->mNumberBuffers; ++i) channels += int(list->mBuffers[i].mNumberChannels);
  return channels;
}

bool isExternal(AudioDeviceID id) {
  auto addr = prop(kAudioDevicePropertyTransportType);
  UInt32 transport = 0;
  UInt32 size = sizeof(transport);
  if (AudioObjectGetPropertyData(id, &addr, 0, nullptr, &size, &transport) != noErr) return false;
  return transport == kAudioDeviceTransportTypeUSB || transport == kAudioDeviceTransportTypeFireWire ||
         transport == kAudioDeviceTransportTypeThunderbolt || transport == kAudioDeviceTransportTypePCI;
}

Float64 nominalRate(AudioDeviceID id) {
  auto addr = prop(kAudioDevicePropertyNominalSampleRate);
  Float64 rate = 0;
  UInt32 size = sizeof(rate);
  AudioObjectGetPropertyData(id, &addr, 0, nullptr, &size, &rate);
  return rate;
}

/**
 * A Core Audio input read through the HAL, as close to the wire as macOS allows: the device runs
 * at exactly the rate asked for (set, checked, and watched), its input stream in the widest
 * integer format it has. Core Audio hands over float32;
 * up to 24 bits that is exact, so each sample comes back unchanged.
 */
class MacCapture : public CaptureSource {
public:
  explicit MacCapture(std::string uid) : uid_(std::move(uid)) {}
  ~MacCapture() override { close(); }

  bool open(uint32_t rate, int channels, std::string& error) override {
    device_ = kAudioObjectUnknown;
    for (AudioDeviceID id : allDevices()) {
      if (stringProperty(id, kAudioDevicePropertyDeviceUID) == uid_ && inputChannels(id) > 0) device_ = id;
    }
    if (device_ == kAudioObjectUnknown) {
      error = "Input not found: " + uid_;
      return false;
    }
    name_ = stringProperty(device_, kAudioObjectPropertyName);
    if (inputChannels(device_) < channels) {
      error = name_ + " has fewer than " + std::to_string(channels) + " input channels";
      return false;
    }
    if (macAudioInputAccess() < 0) {
      error = "Microphone access is off for Audio Harbor: System Settings → Privacy & Security → Microphone";
      return false;
    }
    // No hog mode: inputs are never mixed, and other apps may keep playing through the same
    // interface. Only the rate matters — watched below; a change ends the read and is put back.
    if (!setRate(rate, error)) {
      close();
      return false;
    }
    bits_ = choosePhysicalFormat(rate);
    channels_ = channels;
    ring_.assign(size_t(rate) * size_t(channels) * 2, 0); // 2 s
    head_ = 0;
    tail_ = 0;
    if (AudioDeviceCreateIOProcID(device_, &MacCapture::ioProc, this, &procId_) != noErr) {
      error = "Cannot attach to " + name_;
      close();
      return false;
    }
    rate_ = rate;
    auto alive = prop(kAudioDevicePropertyDeviceIsAlive);
    AudioObjectAddPropertyListener(device_, &alive, &MacCapture::onChange, this);
    auto nominal = prop(kAudioDevicePropertyNominalSampleRate);
    AudioObjectAddPropertyListener(device_, &nominal, &MacCapture::onChange, this);
    listening_ = true;
    if (AudioDeviceStart(device_, procId_) != noErr) {
      error = "Cannot start " + name_;
      close();
      return false;
    }
    return true;
  }

  long read(int32_t* out, size_t maxFrames, int timeoutMs) override {
    const auto until = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
    for (;;) {
      if (lost_.exchange(false)) {
        lastError_ = name_ + " is gone";
        return -1;
      }
      if (rateChanged_.exchange(false)) {
        // Another app set another rate: these samples would be at the wrong rate. Reopening
        // sets ours again; the gap is counted as an overrun.
        lastError_ = name_ + " was switched to " + std::to_string(long(std::lround(nominalRate(device_)))) + " Hz";
        ++overruns_;
        return -1;
      }
      const uint64_t head = head_.load(std::memory_order_acquire);
      const uint64_t tail = tail_.load();
      const size_t frames = std::min<size_t>(maxFrames, size_t((head - tail) / uint64_t(channels_)));
      if (frames > 0) {
        const size_t n = frames * size_t(channels_);
        for (size_t i = 0; i < n; ++i) out[i] = ring_[size_t((tail + i) % ring_.size())];
        tail_.store(tail + n, std::memory_order_release);
        return long(frames);
      }
      if (std::chrono::steady_clock::now() >= until) return 0;
      std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
  }

  void close() override {
    if (listening_) {
      auto alive = prop(kAudioDevicePropertyDeviceIsAlive);
      AudioObjectRemovePropertyListener(device_, &alive, &MacCapture::onChange, this);
      auto nominal = prop(kAudioDevicePropertyNominalSampleRate);
      AudioObjectRemovePropertyListener(device_, &nominal, &MacCapture::onChange, this);
      listening_ = false;
    }
    if (device_ != kAudioObjectUnknown && procId_) {
      AudioDeviceStop(device_, procId_);
      AudioDeviceDestroyIOProcID(device_, procId_);
    }
    procId_ = nullptr;
  }

  int deviceBits() const override { return bits_; }
  uint64_t overruns() const override { return overruns_.load(); }
  std::string lastError() const override { return lastError_; }

private:
  bool setRate(uint32_t rate, std::string& error) {
    if (nominalRate(device_) != Float64(rate)) {
      auto addr = prop(kAudioDevicePropertyNominalSampleRate);
      Float64 want = rate;
      AudioObjectSetPropertyData(device_, &addr, 0, nullptr, sizeof(want), &want);
      // The change lands asynchronously; give the device up to 2 s.
      for (int i = 0; i < 40 && nominalRate(device_) != want; ++i) {
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
      }
    }
    const Float64 actual = nominalRate(device_);
    if (actual != Float64(rate)) {
      error = name_ + " runs at " + std::to_string(long(std::lround(actual))) + " Hz, not " + std::to_string(rate) +
              " Hz";
      return false;
    }
    return true;
  }

  /** The widest integer format at this rate for the first input stream; its bits (32 if float). */
  int choosePhysicalFormat(uint32_t rate) {
    auto streamsAddr = prop(kAudioDevicePropertyStreams, kAudioObjectPropertyScopeInput);
    UInt32 size = 0;
    if (AudioObjectGetPropertyDataSize(device_, &streamsAddr, 0, nullptr, &size) != noErr || size == 0) return 24;
    std::vector<AudioStreamID> streams(size / sizeof(AudioStreamID));
    AudioObjectGetPropertyData(device_, &streamsAddr, 0, nullptr, &size, streams.data());
    const AudioStreamID stream = streams[0];
    auto availAddr = prop(kAudioStreamPropertyAvailablePhysicalFormats);
    if (AudioObjectGetPropertyDataSize(stream, &availAddr, 0, nullptr, &size) == noErr && size) {
      std::vector<AudioStreamRangedDescription> formats(size / sizeof(AudioStreamRangedDescription));
      AudioObjectGetPropertyData(stream, &availAddr, 0, nullptr, &size, formats.data());
      const AudioStreamBasicDescription* best = nullptr;
      for (const auto& f : formats) {
        const auto& d = f.mFormat;
        const bool integer = d.mFormatID == kAudioFormatLinearPCM && !(d.mFormatFlags & kAudioFormatFlagIsFloat);
        const bool rateOk = f.mSampleRateRange.mMinimum <= rate && f.mSampleRateRange.mMaximum >= rate;
        if (integer && rateOk && d.mBitsPerChannel <= 24 && (!best || d.mBitsPerChannel > best->mBitsPerChannel)) {
          best = &d;
        }
      }
      if (best) {
        AudioStreamBasicDescription want = *best;
        want.mSampleRate = rate;
        auto physAddr = prop(kAudioStreamPropertyPhysicalFormat);
        AudioObjectSetPropertyData(stream, &physAddr, 0, nullptr, sizeof(want), &want);
      }
    }
    AudioStreamBasicDescription now = {};
    size = sizeof(now);
    auto physAddr = prop(kAudioStreamPropertyPhysicalFormat);
    if (AudioObjectGetPropertyData(stream, &physAddr, 0, nullptr, &size, &now) == noErr && now.mBitsPerChannel) {
      return (now.mFormatFlags & kAudioFormatFlagIsFloat) ? 32 : int(now.mBitsPerChannel);
    }
    return 24;
  }

  /** Unplugged, or its rate changed: the next read reports it, the recorder gets it back. */
  static OSStatus onChange(AudioObjectID id, UInt32, const AudioObjectPropertyAddress*, void* self) {
    auto* capture = static_cast<MacCapture*>(self);
    UInt32 alive = 1;
    UInt32 size = sizeof(alive);
    auto addr = prop(kAudioDevicePropertyDeviceIsAlive);
    if (AudioObjectGetPropertyData(id, &addr, 0, nullptr, &size, &alive) != noErr || !alive) {
      capture->lost_.store(true);
    } else if (nominalRate(id) != Float64(capture->rate_)) {
      capture->rateChanged_.store(true);
    }
    return noErr;
  }

  static OSStatus ioProc(AudioObjectID, const AudioTimeStamp*, const AudioBufferList* input, const AudioTimeStamp*,
                         AudioBufferList*, const AudioTimeStamp*, void* self) {
    static_cast<MacCapture*>(self)->onInput(input);
    return noErr;
  }

  /** Real-time thread: float32 → left-justified int32 into the ring; no locks, no allocation. */
  void onInput(const AudioBufferList* input) {
    if (!input || input->mNumberBuffers == 0) return;
    const AudioBuffer& first = input->mBuffers[0];
    const UInt32 perFrame = first.mNumberChannels ? first.mNumberChannels : 1;
    const size_t frames = first.mDataByteSize / (sizeof(float) * perFrame);
    const uint64_t head = head_.load();
    const uint64_t room = ring_.size() - size_t(head - tail_.load(std::memory_order_acquire));
    const size_t need = frames * size_t(channels_);
    if (need > room) {
      ++overruns_; // the reader fell 2 s behind: this buffer is lost
      return;
    }
    for (size_t f = 0; f < frames; ++f) {
      int ch = 0;
      for (UInt32 b = 0; b < input->mNumberBuffers && ch < channels_; ++b) {
        const AudioBuffer& buf = input->mBuffers[b];
        const float* data = static_cast<const float*>(buf.mData);
        const UInt32 n = buf.mNumberChannels ? buf.mNumberChannels : 1;
        for (UInt32 c = 0; c < n && ch < channels_; ++c, ++ch) {
          const double v = data ? double(data[f * n + c]) * 2147483648.0 : 0.0;
          const int32_t s = v >= 2147483647.0 ? INT32_MAX : v <= -2147483648.0 ? INT32_MIN : int32_t(std::lrint(v));
          ring_[size_t((head + f * size_t(channels_) + size_t(ch)) % ring_.size())] = s;
        }
      }
      for (; ch < channels_; ++ch) ring_[size_t((head + f * size_t(channels_) + size_t(ch)) % ring_.size())] = 0;
    }
    head_.store(head + need, std::memory_order_release);
  }

  std::string uid_;
  std::string name_;
  AudioDeviceID device_ = kAudioObjectUnknown;
  AudioDeviceIOProcID procId_ = nullptr;
  bool listening_ = false;
  uint32_t rate_ = 0;
  std::atomic<bool> rateChanged_{false};
  int bits_ = 24;
  int channels_ = 2;
  std::vector<int32_t> ring_;
  std::atomic<uint64_t> head_{0};
  std::atomic<uint64_t> tail_{0};
  std::atomic<uint64_t> overruns_{0};
  std::atomic<bool> lost_{false};
  std::string lastError_;
};

} // namespace

std::vector<CaptureDeviceInfo> listCaptureDevices() {
  std::vector<CaptureDeviceInfo> external, internal;
  for (AudioDeviceID id : allDevices()) {
    if (inputChannels(id) < 2) continue; // stereo inputs only (S/PDIF is two channels)
    CaptureDeviceInfo info;
    info.id = stringProperty(id, kAudioDevicePropertyDeviceUID);
    info.name = stringProperty(id, kAudioObjectPropertyName);
    if (info.id.empty()) continue;
    (isExternal(id) ? external : internal).push_back(std::move(info));
  }
  // Interfaces first: an S/PDIF input is on one of them, not on the built-in microphone.
  external.insert(external.end(), internal.begin(), internal.end());
  return external;
}

std::unique_ptr<CaptureSource> makeMacCapture(const std::string& device) {
  return std::make_unique<MacCapture>(device);
}

#endif
