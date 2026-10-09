#if defined(__linux__)

#include "PlaybackFeed.h"
#include "Player.h"

#include <alsa/asoundlib.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <thread>
#include <vector>

namespace {

bool endsWithCi(const std::string& s, const char* ext) {
  const size_t n = std::strlen(ext);
  if (s.size() < n) return false;
  for (size_t i = 0; i < n; ++i) {
    const char a = s[s.size() - n + i];
    const char b = ext[i];
    if ((a | 32) != (b | 32)) return false;
  }
  return true;
}

class LinuxPlayer final : public IPlayer {
public:
  ~LinuxPlayer() override {
    cancelDecode_();
    stop();
  }

  std::vector<PlayerDevice> listDevices() override {
    std::vector<PlayerDevice> devices;
    devices.push_back({"default", "System Default (PipeWire/Pulse)", false, false, false});

    void** hints = nullptr;
    if (snd_device_name_hint(-1, "pcm", &hints) == 0) {
      for (void** h = hints; *h; ++h) {
        char* name = snd_device_name_get_hint(*h, "NAME");
        char* desc = snd_device_name_get_hint(*h, "DESC");
        char* ioid = snd_device_name_get_hint(*h, "IOID");
        if (name && (!ioid || std::strcmp(ioid, "Input") != 0)) {
          PlayerDevice d;
          d.uid = name;
          d.name = desc ? desc : name;
          const bool hw = std::strncmp(name, "hw:", 3) == 0 || std::strncmp(name, "plughw:", 7) == 0;
          d.isExternal = hw;
          d.supportsExclusive = hw;
          d.supportsDop = hw;
          devices.push_back(std::move(d));
        }
        free(name);
        free(desc);
        free(ioid);
      }
      snd_device_name_free_hint(hints);
    }
    return devices;
  }

  void setDevice(const std::string* uidOrNull) override {
    std::lock_guard lock(mutex_);
    selectedUid_ = uidOrNull ? *uidOrNull : "default";
    emit_("deviceChange", "{}");
  }

  void setOutputMode(HarborOutputMode mode) override {
    std::lock_guard lock(mutex_);
    requestedMode_ = mode;
    refreshEffective_();
    emit_("state", nullptr);
  }

  void setDsdPcmLevel(int db) override {
    std::lock_guard lock(mutex_);
    dsdLevel_ = (db == 0 || db == 3 || db == 6) ? db : 3;
  }

  bool load(const std::string& path) override {
    cancelDecode_();
    stopUnlocked_();
    std::lock_guard lock(mutex_);
    path_ = path;
    state_ = HARBOR_STATE_LOADING;
    error_.clear();
    pcm_.clear();
    dop_.clear();
    readyFrames_.store(0);
    totalFrames_.store(0);
    isDop_ = false;
    sampleRate_ = 44100;
    channels_ = 2;
    frameIndex_ = 0;

    const bool isDsd = endsWithCi(path, ".dsf") || endsWithCi(path, ".dff");
    refreshEffective_();
    if (!isDsd && effectiveMode_ == HARBOR_MODE_DOP) {
      effectiveMode_ = HARBOR_MODE_EXCLUSIVE;
      badge_ = "Exclusive (PCM, DoP N/A)";
    }

    FrameSourceOptions options;
    options.dsdLevelDb = dsdLevel_;
    options.dop = isDsd && effectiveMode_ == HARBOR_MODE_DOP;
    if (!feed_.open(path, options, error_)) {
      state_ = HARBOR_STATE_FAILED;
      emit_("state", nullptr);
      return false;
    }
    sampleRate_ = feed_.sampleRate();
    channels_ = feed_.channels();
    isDop_ = feed_.isDop();
    totalFrames_.store(size_t(feed_.frameCount()));
    duration_ = double(feed_.frameCount()) / double(sampleRate_ ? sampleRate_ : 1);

    if (isDop_) {
      badge_ = "DoP";
      cancelDecodeFlag_.store(false);
      feed_.startDopFill(dop_, readyFrames_, cancelDecodeFlag_);
    } else {
      if (isDsd) {
        badge_ = effectiveMode_ == HARBOR_MODE_EXCLUSIVE
                   ? "Exclusive · DSD→PCM"
                   : "Shared · DSD→PCM";
      } else if (effectiveMode_ == HARBOR_MODE_EXCLUSIVE) {
        badge_ = "Exclusive";
      }
      cancelDecodeFlag_.store(false);
      feed_.startFloatFill(pcm_, readyFrames_, cancelDecodeFlag_);
    }

    const size_t want = std::min<size_t>(4096, totalFrames_.load());
    for (int i = 0; i < 20000; ++i) {
      if (readyFrames_.load(std::memory_order_acquire) >= want) break;
      if (cancelDecodeFlag_.load()) break;
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }

    if (!openAlsa_()) {
      cancelDecode_();
      if (error_.empty()) error_ = "ALSA open failed";
      state_ = HARBOR_STATE_FAILED;
      emit_("state", nullptr);
      return false;
    }
    state_ = HARBOR_STATE_PAUSED;
    emit_("state", nullptr);
    return true;
  }

  void play() override {
    std::lock_guard lock(mutex_);
    if (state_ == HARBOR_STATE_PAUSED || state_ == HARBOR_STATE_IDLE) {
      state_ = HARBOR_STATE_PLAYING;
      ensureThread_();
      emit_("state", nullptr);
    }
  }

  void pause() override {
    std::lock_guard lock(mutex_);
    if (state_ == HARBOR_STATE_PLAYING) {
      state_ = HARBOR_STATE_PAUSED;
      emit_("state", nullptr);
    }
  }

  void stop() override {
    std::lock_guard lock(mutex_);
    stopUnlocked_();
    emit_("state", nullptr);
  }

  void seek(double seconds) override {
    std::lock_guard lock(mutex_);
    frameIndex_ = size_t(std::max(0.0, seconds) * sampleRate_);
    emit_("state", nullptr);
  }

  void setVolume(float level) override {
    std::lock_guard lock(mutex_);
    volume_ = std::clamp(level, 0.0f, 1.0f);
    emit_("state", nullptr);
  }

  HarborEngineState getState() override {
    std::lock_guard lock(mutex_);
    HarborEngineState s {};
    s.state = state_;
    s.position_secs = double(frameIndex_.load()) / double(sampleRate_ ? sampleRate_ : 1);
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
  void refreshEffective_() {
    effectiveMode_ = HARBOR_MODE_SHARED;
    badge_.clear();
    if (requestedMode_ == HARBOR_MODE_SHARED) return;
    const bool hw = selectedUid_.rfind("hw:", 0) == 0 || selectedUid_.rfind("plughw:", 0) == 0;
    if (!hw) {
      badge_ = "Shared (pick hw: device for Exclusive/DoP)";
      return;
    }
    effectiveMode_ = requestedMode_;
  }

  bool openAlsa_() {
    closeAlsa_();
    std::string dev = selectedUid_.empty() ? "default" : selectedUid_;
    if (effectiveMode_ == HARBOR_MODE_EXCLUSIVE || effectiveMode_ == HARBOR_MODE_DOP) {
      if (dev == "default") {
        error_ = "Exclusive/DoP needs an hw: device";
        return false;
      }
    }
    if (snd_pcm_open(&pcmHandle_, dev.c_str(), SND_PCM_STREAM_PLAYBACK, 0) < 0) return false;

    snd_pcm_hw_params_t* params = nullptr;
    snd_pcm_hw_params_alloca(&params);
    snd_pcm_hw_params_any(pcmHandle_, params);
    snd_pcm_hw_params_set_access(pcmHandle_, params, SND_PCM_ACCESS_RW_INTERLEAVED);
    if (isDop_) {
      snd_pcm_hw_params_set_format(pcmHandle_, params, SND_PCM_FORMAT_S32_LE);
    } else {
      snd_pcm_hw_params_set_format(pcmHandle_, params, SND_PCM_FORMAT_FLOAT_LE);
    }
    snd_pcm_hw_params_set_channels(pcmHandle_, params, channels_);
    unsigned int rate = sampleRate_;
    snd_pcm_hw_params_set_rate_near(pcmHandle_, params, &rate, nullptr);
    sampleRate_ = rate;
    if (snd_pcm_hw_params(pcmHandle_, params) < 0) {
      closeAlsa_();
      return false;
    }
    return true;
  }

  void closeAlsa_() {
    if (!pcmHandle_) return;
    snd_pcm_drain(pcmHandle_);
    snd_pcm_close(pcmHandle_);
    pcmHandle_ = nullptr;
  }

  void cancelDecode_() {
    cancelDecodeFlag_.store(true);
    feed_.join();
    cancelDecodeFlag_.store(false);
  }

  void stopUnlocked_() {
    state_ = HARBOR_STATE_IDLE;
    cancelDecode_();
    feed_.close();
    closeAlsa_();
    path_.clear();
    pcm_.clear();
    dop_.clear();
    readyFrames_.store(0);
    totalFrames_.store(0);
    frameIndex_ = 0;
    duration_ = -1;
  }

  void ensureThread_() {
    if (threadRunning_) return;
    threadRunning_ = true;
    std::thread([this] {
      constexpr size_t block = 1024;
      while (true) {
        HarborPlaybackState st;
        {
          std::lock_guard lock(mutex_);
          st = state_;
          if (st != HARBOR_STATE_PLAYING) {
            threadRunning_ = false;
            break;
          }
        }
        size_t idx = frameIndex_.load();
        const size_t ready = readyFrames_.load(std::memory_order_acquire);
        const size_t total = totalFrames_.load(std::memory_order_acquire);
        if (total > 0 && idx >= total) {
          std::lock_guard lock(mutex_);
          state_ = HARBOR_STATE_IDLE;
          emit_("ended", "{}");
          emit_("state", nullptr);
          threadRunning_ = false;
          break;
        }
        if (idx >= ready) {
          std::this_thread::sleep_for(std::chrono::milliseconds(2));
          continue;
        }
        const size_t n = std::min(block, ready - idx);
        if (isDop_) {
          snd_pcm_writei(pcmHandle_, dop_.data() + idx * channels_, n);
        } else {
          std::vector<float> tmp(n * channels_);
          for (size_t i = 0; i < n * channels_; ++i) tmp[i] = pcm_[idx * channels_ + i] * volume_;
          snd_pcm_writei(pcmHandle_, tmp.data(), n);
        }
        frameIndex_.store(idx + n);
      }
    }).detach();
  }

  void emit_(const char* event, const char* json) {
    if (eventFn_) eventFn_(event, json ? json : "{}");
  }

  std::mutex mutex_;
  EventFn eventFn_;
  std::string path_;
  std::string selectedUid_ = "default";
  std::string badge_;
  std::string error_;
  HarborOutputMode requestedMode_ = HARBOR_MODE_SHARED;
  HarborOutputMode effectiveMode_ = HARBOR_MODE_SHARED;
  HarborPlaybackState state_ = HARBOR_STATE_IDLE;
  double duration_ = -1;
  float volume_ = 0.8f;
  int dsdLevel_ = 3;
  uint32_t sampleRate_ = 44100;
  uint16_t channels_ = 2;
  bool isDop_ = false;
  std::vector<float> pcm_;
  std::vector<int32_t> dop_;
  PlaybackFeed feed_;
  std::atomic<size_t> frameIndex_ { 0 };
  std::atomic<size_t> readyFrames_ { 0 };
  std::atomic<size_t> totalFrames_ { 0 };
  std::atomic<bool> cancelDecodeFlag_ { false };
  snd_pcm_t* pcmHandle_ = nullptr;
  bool threadRunning_ = false;
};

} // namespace

IPlayer* createLinuxPlayer() {
  return new LinuxPlayer();
}

#endif // __linux__
