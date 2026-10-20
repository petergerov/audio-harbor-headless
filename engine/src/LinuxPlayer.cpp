#if defined(__linux__)

#include "PlaybackFeed.h"
#include "Player.h"

#include <alsa/asoundlib.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
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

/** Sample formats the PCM path can write, best first. A hw: device takes only what the DAC does. */
struct AlsaFormat {
  snd_pcm_format_t format;
  const char* name;
};
constexpr AlsaFormat kPcmFormats[] = {
    {SND_PCM_FORMAT_FLOAT_LE, "float"},
    {SND_PCM_FORMAT_S32_LE, "32-bit"},
    {SND_PCM_FORMAT_S24_LE, "24-bit"},
    {SND_PCM_FORMAT_S24_3LE, "24-bit"},
    {SND_PCM_FORMAT_S16_LE, "16-bit"},
};

/**
 * Rate and sample width a card runs at, from /proc/asound — behind plughw the card may run at
 * another rate or format than the one written to it. `dev` is plughw:CARD=<id>,DEV=<n> (or
 * plughw:<card>,<device>). False when the card or an open substream is not found.
 */
bool cardFormat(const std::string& dev, uint32_t& rate, int& bits) {
  std::string card;
  std::string device = "0";
  int position = 0;
  size_t start = dev.find(':') + 1;
  while (start > 0 && start <= dev.size()) {
    const size_t end = dev.find(',', start);
    const std::string part = dev.substr(start, end == std::string::npos ? std::string::npos : end - start);
    if (part.rfind("CARD=", 0) == 0) card = part.substr(5);
    else if (part.rfind("DEV=", 0) == 0) device = part.substr(4);
    else if (position == 0) card = part;
    else if (position == 1) device = part;
    ++position;
    if (end == std::string::npos) break;
    start = end + 1;
  }
  if (card.empty() || device.empty() || device.find_first_not_of("0123456789") != std::string::npos) return false;
  const int index = snd_card_get_index(card.c_str());
  if (index < 0) return false;
  for (int sub = 0; sub < 32; ++sub) {
    char path[128];
    std::snprintf(path, sizeof(path), "/proc/asound/card%d/pcm%sp/sub%d/hw_params", index, device.c_str(), sub);
    FILE* f = std::fopen(path, "r");
    if (!f) break;
    char line[128];
    char name[32] = {};
    unsigned long hz = 0;
    while (std::fgets(line, sizeof(line), f)) {
      if (std::sscanf(line, "format: %31s", name) == 1) continue;
      std::sscanf(line, "rate: %lu", &hz);
    }
    std::fclose(f);
    // A closed substream has just "closed".
    const snd_pcm_format_t format = name[0] ? snd_pcm_format_value(name) : SND_PCM_FORMAT_UNKNOWN;
    if (format == SND_PCM_FORMAT_UNKNOWN || !hz) continue;
    rate = uint32_t(hz);
    bits = snd_pcm_format_width(format);
    return true;
  }
  return false;
}

/** Float (full scale ±1) to the device format, clipped instead of wrapped. */
void convertFloat(const float* in, size_t samples, float gain, snd_pcm_format_t format, uint8_t* out) {
  auto scaled = [&](size_t i, double full) {
    const double v = std::nearbyint(double(in[i]) * gain * full);
    return int64_t(std::clamp(v, -full, full - 1.0));
  };
  switch (format) {
    case SND_PCM_FORMAT_FLOAT_LE: {
      auto* o = reinterpret_cast<float*>(out);
      for (size_t i = 0; i < samples; ++i) o[i] = std::clamp(in[i] * gain, -1.0f, 1.0f);
      break;
    }
    case SND_PCM_FORMAT_S32_LE: {
      auto* o = reinterpret_cast<int32_t*>(out);
      for (size_t i = 0; i < samples; ++i) o[i] = int32_t(scaled(i, 2147483648.0));
      break;
    }
    case SND_PCM_FORMAT_S24_LE: {
      // 24 bits in the low three bytes of a 32-bit word.
      auto* o = reinterpret_cast<int32_t*>(out);
      for (size_t i = 0; i < samples; ++i) o[i] = int32_t(scaled(i, 8388608.0));
      break;
    }
    case SND_PCM_FORMAT_S24_3LE:
      for (size_t i = 0; i < samples; ++i) {
        const int32_t v = int32_t(scaled(i, 8388608.0));
        out[i * 3] = uint8_t(v);
        out[i * 3 + 1] = uint8_t(v >> 8);
        out[i * 3 + 2] = uint8_t(v >> 16);
      }
      break;
    default: {
      auto* o = reinterpret_cast<int16_t*>(out);
      for (size_t i = 0; i < samples; ++i) o[i] = int16_t(scaled(i, 32768.0));
      break;
    }
  }
}

class LinuxPlayer final : public IPlayer {
public:
  ~LinuxPlayer() override {
    cancelDecode_();
    stop();
  }

  /**
   * One entry per playback device of each sound card — "SMSL USB AUDIO", not the dozen ALSA
   * aliases of it (plughw, sysdefault, front, surround51, iec958, dmix …). The uid is
   * hw:CARD=<id>,DEV=<n>: Exclusive / DoP open it as is, Shared through plughw.
   */
  std::vector<PlayerDevice> listDevices() override {
    std::vector<PlayerDevice> devices;
    devices.push_back({"default", "System Default", false, false, false});

    snd_ctl_card_info_t* cardInfo = nullptr;
    snd_ctl_card_info_alloca(&cardInfo);
    snd_pcm_info_t* pcmInfo = nullptr;
    snd_pcm_info_alloca(&pcmInfo);
    int card = -1;
    while (snd_card_next(&card) == 0 && card >= 0) {
      snd_ctl_t* ctl = nullptr;
      const std::string ctlName = "hw:" + std::to_string(card);
      if (snd_ctl_open(&ctl, ctlName.c_str(), 0) < 0) continue;
      if (snd_ctl_card_info(ctl, cardInfo) < 0) {
        snd_ctl_close(ctl);
        continue;
      }
      const std::string cardId = snd_ctl_card_info_get_id(cardInfo);
      const std::string cardName = snd_ctl_card_info_get_name(cardInfo);
      const bool usb = std::strcmp(snd_ctl_card_info_get_driver(cardInfo), "USB-Audio") == 0;
      std::vector<std::pair<int, std::string>> outputs;
      int dev = -1;
      while (snd_ctl_pcm_next_device(ctl, &dev) == 0 && dev >= 0) {
        snd_pcm_info_set_device(pcmInfo, unsigned(dev));
        snd_pcm_info_set_subdevice(pcmInfo, 0);
        snd_pcm_info_set_stream(pcmInfo, SND_PCM_STREAM_PLAYBACK);
        if (snd_ctl_pcm_info(ctl, pcmInfo) < 0) continue;  // capture only
        outputs.emplace_back(dev, snd_pcm_info_get_name(pcmInfo));
      }
      snd_ctl_close(ctl);
      for (const auto& [d, devName] : outputs) {
        PlayerDevice pd;
        pd.uid = "hw:CARD=" + cardId + ",DEV=" + std::to_string(d);
        pd.name = outputs.size() > 1 ? cardName + " · " + devName : cardName;
        pd.isExternal = usb;
        pd.supportsExclusive = true;
        pd.supportsDop = true;
        devices.push_back(std::move(pd));
      }
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
    if (pcmHandle_) {
      s.stream_rate = sampleRate_;
      s.device_rate = deviceRate_;
      s.device_bits = deviceBits_;
      s.is_dop = isDop_ ? 1 : 0;
    }
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
      badge_ = "Shared (pick the DAC itself for Exclusive/DoP)";
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
    } else if (dev.rfind("hw:", 0) == 0) {
      // Shared: the same card through plughw, which converts format and rate.
      dev = "plug" + dev;
    }
    int err = snd_pcm_open(&pcmHandle_, dev.c_str(), SND_PCM_STREAM_PLAYBACK, 0);
    if (err < 0) {
      pcmHandle_ = nullptr;
      error_ = "Cannot open " + dev + ": " + snd_strerror(err);
      return false;
    }
    auto fail = [&](const std::string& why) {
      error_ = why;
      closeAlsa_();
      return false;
    };

    snd_pcm_hw_params_t* params = nullptr;
    snd_pcm_hw_params_alloca(&params);
    snd_pcm_hw_params_any(pcmHandle_, params);
    if (snd_pcm_hw_params_set_access(pcmHandle_, params, SND_PCM_ACCESS_RW_INTERLEAVED) < 0) {
      return fail(dev + " does not take interleaved samples");
    }
    // The device must take the format we write — writing float into an integer
    // device sounds like a heavily overdriven signal.
    if (isDop_) {
      if (snd_pcm_hw_params_set_format(pcmHandle_, params, SND_PCM_FORMAT_S32_LE) < 0) {
        return fail(dev + " does not take 32-bit samples, which DoP needs");
      }
      format_ = SND_PCM_FORMAT_S32_LE;
    } else {
      bool found = false;
      for (const auto& f : kPcmFormats) {
        if (snd_pcm_hw_params_test_format(pcmHandle_, params, f.format) == 0 &&
            snd_pcm_hw_params_set_format(pcmHandle_, params, f.format) == 0) {
          format_ = f.format;
          found = true;
          break;
        }
      }
      if (!found) return fail(dev + " takes none of float / 32 / 24 / 16-bit samples");
    }
    if (snd_pcm_hw_params_set_channels(pcmHandle_, params, channels_) < 0) {
      return fail(dev + " does not play " + std::to_string(channels_) + " channels");
    }
    // No resampling here: a hw: device either plays the file's rate or refuses —
    // a near rate would play at the wrong speed (DoP would stop being DSD).
    unsigned int rate = sampleRate_;
    if (snd_pcm_hw_params_set_rate(pcmHandle_, params, rate, 0) < 0) {
      return fail(dev + " does not play " + std::to_string(rate) + " Hz — pick its plughw: entry or Shared");
    }
    snd_pcm_uframes_t buffer = sampleRate_ / 2;  // ~0.5 s
    snd_pcm_hw_params_set_buffer_size_near(pcmHandle_, params, &buffer);
    err = snd_pcm_hw_params(pcmHandle_, params);
    if (err < 0) return fail(std::string("ALSA setup failed: ") + snd_strerror(err));
    frameBytes_ = size_t(snd_pcm_format_physical_width(format_) / 8) * channels_;

    // What the DAC gets. hw: runs at the file's rate; its significant bits are the DAC's
    // (24 in a 32-bit sample for most USB DACs). Behind plughw the card says it in /proc.
    deviceRate_ = 0;
    deviceBits_ = 0;
    if (dev.rfind("plughw:", 0) == 0) {
      cardFormat(dev, deviceRate_, deviceBits_);
    } else if (dev.rfind("hw:", 0) == 0) {
      const int sbits = snd_pcm_hw_params_get_sbits(params);
      deviceRate_ = rate;
      deviceBits_ = sbits > 0 ? sbits : snd_pcm_format_width(format_);
    }
    return true;
  }

  /** Writes all frames, recovering from an underrun; false when the device is gone. */
  bool writeFrames_(const void* data, size_t frames) {
    const auto* p = static_cast<const uint8_t*>(data);
    while (frames > 0) {
      snd_pcm_sframes_t n = snd_pcm_writei(pcmHandle_, p, frames);
      if (n < 0) {
        n = snd_pcm_recover(pcmHandle_, int(n), 1);
        if (n < 0) return false;
        continue;
      }
      p += size_t(n) * frameBytes_;
      frames -= size_t(n);
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
      std::vector<uint8_t> out;
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
        bool ok = true;
        if (isDop_) {
          ok = writeFrames_(dop_.data() + idx * channels_, n);
        } else {
          out.resize(n * frameBytes_);
          convertFloat(pcm_.data() + idx * channels_, n * channels_, volume_, format_, out.data());
          ok = writeFrames_(out.data(), n);
        }
        if (!ok) {
          std::lock_guard lock(mutex_);
          error_ = "Audio device stopped responding";
          state_ = HARBOR_STATE_FAILED;
          emit_("state", nullptr);
          threadRunning_ = false;
          break;
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
  snd_pcm_format_t format_ = SND_PCM_FORMAT_FLOAT_LE;
  uint32_t deviceRate_ = 0;
  int deviceBits_ = 0;
  size_t frameBytes_ = 8;
  bool threadRunning_ = false;
};

} // namespace

IPlayer* createLinuxPlayer() {
  return new LinuxPlayer();
}

#endif // __linux__
