#include "Player.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <thread>

#if defined(__APPLE__)
#include <CoreAudio/CoreAudio.h>
#endif

namespace {

class StubPlayer final : public IPlayer {
public:
  std::vector<PlayerDevice> listDevices() override {
    std::vector<PlayerDevice> devices;

#if defined(__APPLE__)
    AudioObjectPropertyAddress addr {
      kAudioHardwarePropertyDevices,
      kAudioObjectPropertyScopeGlobal,
      kAudioObjectPropertyElementMain
    };
    UInt32 size = 0;
    AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &addr, 0, nullptr, &size);
    const auto count = size / sizeof(AudioDeviceID);
    std::vector<AudioDeviceID> ids(count);
    if (count > 0) {
      AudioObjectGetPropertyData(kAudioObjectSystemObject, &addr, 0, nullptr, &size, ids.data());
    }
    for (auto id : ids) {
      AudioObjectPropertyAddress outAddr {
        kAudioDevicePropertyStreams,
        kAudioDevicePropertyScopeOutput,
        kAudioObjectPropertyElementMain
      };
      UInt32 streamSize = 0;
      if (AudioObjectGetPropertyDataSize(id, &outAddr, 0, nullptr, &streamSize) != noErr || streamSize == 0) {
        continue;
      }

      PlayerDevice d;
      d.uid = std::to_string(id);

      AudioObjectPropertyAddress nameAddr {
        kAudioObjectPropertyName,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
      };
      CFStringRef nameRef = nullptr;
      UInt32 nameSize = sizeof(nameRef);
      if (AudioObjectGetPropertyData(id, &nameAddr, 0, nullptr, &nameSize, &nameRef) == noErr && nameRef) {
        char buf[256] {};
        CFStringGetCString(nameRef, buf, sizeof(buf), kCFStringEncodingUTF8);
        d.name = buf;
        CFRelease(nameRef);
      } else {
        d.name = "Device " + d.uid;
      }

      AudioObjectPropertyAddress transportAddr {
        kAudioDevicePropertyTransportType,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
      };
      UInt32 transport = 0;
      UInt32 tSize = sizeof(transport);
      if (AudioObjectGetPropertyData(id, &transportAddr, 0, nullptr, &tSize, &transport) == noErr) {
        d.isExternal = transport == kAudioDeviceTransportTypeUSB
                    || transport == kAudioDeviceTransportTypeFireWire
                    || transport == kAudioDeviceTransportTypeThunderbolt
                    || transport == kAudioDeviceTransportTypePCI;
      }
      d.supportsExclusive = d.isExternal;
      d.supportsDop = d.isExternal;
      devices.push_back(std::move(d));
    }
#endif

    if (devices.empty()) {
      PlayerDevice def;
      def.uid = "default";
      def.name = "System Default";
      devices.push_back(def);
    }
    return devices;
  }

  void setDevice(const std::string* uidOrNull) override {
    std::lock_guard lock(mutex_);
    selectedUid_ = uidOrNull ? *uidOrNull : std::string();
    emitLocked_("deviceChange", "{}");
  }

  void setOutputMode(HarborOutputMode mode) override {
    std::lock_guard lock(mutex_);
    requestedMode_ = mode;
    refreshEffectiveLocked_();
  }

  void setDsdPcmLevel(int db) override {
    std::lock_guard lock(mutex_);
    dsdLevel_ = (db == 6 || db == 3 || db == 0) ? db : 3;
  }

  bool load(const std::string& path) override {
    std::lock_guard lock(mutex_);
    path_ = path;
    state_ = HARBOR_STATE_LOADING;
    position_ = 0;
    duration_ = 180.0; // stub duration until real decoder wired
    error_.clear();
    refreshEffectiveLocked_();
    state_ = HARBOR_STATE_PAUSED;
    emitLocked_("state", nullptr);
    return true;
  }

  void play() override {
    std::lock_guard lock(mutex_);
    if (path_.empty()) return;
    state_ = HARBOR_STATE_PLAYING;
    playStarted_ = std::chrono::steady_clock::now();
    basePosition_ = position_;
    ensureTicker_();
    emitLocked_("state", nullptr);
  }

  void pause() override {
    std::lock_guard lock(mutex_);
    if (state_ == HARBOR_STATE_PLAYING) {
      position_ = currentPositionLocked_();
      state_ = HARBOR_STATE_PAUSED;
      emitLocked_("state", nullptr);
    }
  }

  void stop() override {
    std::lock_guard lock(mutex_);
    position_ = 0;
    basePosition_ = 0;
    state_ = HARBOR_STATE_IDLE;
    path_.clear();
    emitLocked_("state", nullptr);
  }

  void seek(double seconds) override {
    std::lock_guard lock(mutex_);
    position_ = std::max(0.0, seconds);
    basePosition_ = position_;
    playStarted_ = std::chrono::steady_clock::now();
    emitLocked_("state", nullptr);
  }

  void setVolume(float level) override {
    std::lock_guard lock(mutex_);
    volume_ = std::clamp(level, 0.0f, 1.0f);
    emitLocked_("state", nullptr);
  }

  HarborEngineState getState() override {
    std::lock_guard lock(mutex_);
    HarborEngineState s {};
    s.state = state_;
    s.position_secs = currentPositionLocked_();
    s.duration_secs = duration_;
    s.effective_mode = effectiveMode_;
    std::snprintf(s.conversion_badge, sizeof(s.conversion_badge), "%s", badge_.c_str());
    s.volume = volume_;
    std::snprintf(s.error, sizeof(s.error), "%s", error_.c_str());
    return s;
  }

  void setEventCallback(EventFn fn) override {
    std::lock_guard lock(mutex_);
    eventFn_ = std::move(fn);
  }

private:
  double currentPositionLocked_() const {
    if (state_ != HARBOR_STATE_PLAYING) return position_;
    const auto elapsed = std::chrono::duration<double>(std::chrono::steady_clock::now() - playStarted_).count();
    return basePosition_ + elapsed;
  }

  void refreshEffectiveLocked_() {
    effectiveMode_ = HARBOR_MODE_SHARED;
    badge_.clear();
    if (requestedMode_ == HARBOR_MODE_SHARED) return;

    bool external = false;
    for (const auto& d : listDevicesUnsafe_()) {
      if (!selectedUid_.empty() && d.uid == selectedUid_) {
        external = d.isExternal;
        break;
      }
      if (selectedUid_.empty() && d.isExternal) {
        external = true;
        break;
      }
    }
    if (!external) {
      badge_ = "Shared (no external DAC)";
      return;
    }
    effectiveMode_ = requestedMode_;
    if (requestedMode_ == HARBOR_MODE_EXCLUSIVE) badge_ = "Exclusive";
    if (requestedMode_ == HARBOR_MODE_DOP) badge_ = "DoP";
  }

  std::vector<PlayerDevice> listDevicesUnsafe_() {
    // Avoid re-entrancy; call platform list without holding logic that needs mutex again
    return StubPlayer::listDevices();
  }

  void emitLocked_(const char* event, const char* json) {
    if (eventFn_) eventFn_(event, json ? json : "{}");
  }

  void ensureTicker_() {
    if (tickerRunning_) return;
    tickerRunning_ = true;
    std::thread([this] {
      while (true) {
        std::this_thread::sleep_for(std::chrono::milliseconds(250));
        std::lock_guard lock(mutex_);
        if (state_ != HARBOR_STATE_PLAYING) {
          tickerRunning_ = false;
          break;
        }
        if (currentPositionLocked_() >= duration_) {
          state_ = HARBOR_STATE_IDLE;
          position_ = duration_;
          emitLocked_("ended", "{}");
          emitLocked_("state", nullptr);
          tickerRunning_ = false;
          break;
        }
        emitLocked_("state", nullptr);
      }
    }).detach();
  }

  std::mutex mutex_;
  EventFn eventFn_;
  std::string path_;
  std::string selectedUid_;
  HarborOutputMode requestedMode_ = HARBOR_MODE_SHARED;
  HarborOutputMode effectiveMode_ = HARBOR_MODE_SHARED;
  HarborPlaybackState state_ = HARBOR_STATE_IDLE;
  double position_ = 0;
  double basePosition_ = 0;
  double duration_ = -1;
  float volume_ = 0.8f;
  int dsdLevel_ = 3;
  std::string badge_;
  std::string error_;
  std::chrono::steady_clock::time_point playStarted_ {};
  bool tickerRunning_ = false;
};

} // namespace

IPlayer* createStubPlayer() {
  return new StubPlayer();
}
