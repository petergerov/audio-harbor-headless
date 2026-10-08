#if defined(HARBOR_WITH_JUCE) && !defined(__APPLE__) && !defined(__linux__)

#include "Player.h"

#include <cstdio>

#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_audio_utils/juce_audio_utils.h>
#include <juce_events/juce_events.h>

namespace {

class JucePlayer final : public IPlayer,
                         private juce::AudioIODeviceCallback,
                         private juce::ChangeListener {
public:
  JucePlayer() {
    juce::MessageManager::getInstance();
    formatManager_.registerBasicFormats();
    deviceManager_.initialiseWithDefaultDevices(0, 2);
    deviceManager_.addAudioCallback(this);
    transport_.addChangeListener(this);
  }

  ~JucePlayer() override {
    stop();
    deviceManager_.removeAudioCallback(this);
    transport_.removeChangeListener(this);
    transport_.setSource(nullptr);
    readerSource_.reset();
  }

  std::vector<PlayerDevice> listDevices() override {
    std::vector<PlayerDevice> out;
    const auto& types = deviceManager_.getAvailableDeviceTypes();
    for (auto* type : types) {
      type->scanForDevices();
      for (const auto& name : type->getDeviceNames(false)) {
        PlayerDevice d;
        d.uid = (type->getTypeName() + "|" + name).toStdString();
        d.name = name.toStdString();
        const auto lower = name.toLowerCase();
        d.isExternal = lower.contains("usb") || lower.contains("thunderbolt")
                    || lower.contains("firewire") || lower.contains("dac");
        d.supportsExclusive = d.isExternal;
        d.supportsDop = d.isExternal;
        out.push_back(std::move(d));
      }
    }
    if (out.empty()) {
      PlayerDevice def;
      def.uid = "default";
      def.name = "System Default";
      out.push_back(def);
    }
    return out;
  }

  void setDevice(const std::string* uidOrNull) override {
    juce::AudioDeviceManager::AudioDeviceSetup setup;
    deviceManager_.getAudioDeviceSetup(setup);
    if (!uidOrNull || uidOrNull->empty() || *uidOrNull == "default") {
      deviceManager_.setAudioDeviceSetup(setup, true);
    } else {
      const auto uid = juce::String(*uidOrNull);
      const auto pipe = uid.indexOfChar('|');
      if (pipe > 0) {
        setup.outputDeviceName = uid.substring(pipe + 1);
        deviceManager_.setAudioDeviceSetup(setup, true);
      }
    }
    selectedUid_ = uidOrNull ? *uidOrNull : std::string();
    refreshEffective();
    emit("deviceChange", "{}");
  }

  void setOutputMode(HarborOutputMode mode) override {
    requestedMode_ = mode;
    refreshEffective();
    emit("state", nullptr);
  }

  void setDsdPcmLevel(int db) override {
    dsdLevel_ = (db == 0 || db == 3 || db == 6) ? db : 3;
  }

  bool load(const std::string& path) override {
    stopInternal();
    auto* reader = formatManager_.createReaderFor(juce::File(path));
    if (!reader) {
      error_ = "Unsupported or unreadable file";
      state_ = HARBOR_STATE_FAILED;
      emit("state", nullptr);
      return false;
    }
    readerSource_ = std::make_unique<juce::AudioFormatReaderSource>(reader, true);
    transport_.setSource(readerSource_.get(), 0, nullptr, reader->sampleRate);
    duration_ = reader->lengthInSamples / reader->sampleRate;
    path_ = path;
    error_.clear();
    state_ = HARBOR_STATE_PAUSED;
    refreshEffective();
    emit("state", nullptr);
    return true;
  }

  void play() override {
    if (!readerSource_) return;
    transport_.start();
    state_ = HARBOR_STATE_PLAYING;
    emit("state", nullptr);
  }

  void pause() override {
    transport_.stop();
    if (state_ == HARBOR_STATE_PLAYING) {
      state_ = HARBOR_STATE_PAUSED;
      emit("state", nullptr);
    }
  }

  void stop() override { stopInternal(); emit("state", nullptr); }

  void seek(double seconds) override {
    if (!readerSource_) return;
    transport_.setPosition(seconds);
    emit("state", nullptr);
  }

  void setVolume(float level) override {
    volume_ = juce::jlimit(0.0f, 1.0f, level);
    // Hardware volume preferred later; gain on shared path only when no HW volume.
    transport_.setGain(volume_);
    emit("state", nullptr);
  }

  HarborEngineState getState() override {
    HarborEngineState s {};
    s.state = state_;
    s.position_secs = transport_.getCurrentPosition();
    s.duration_secs = duration_;
    s.effective_mode = effectiveMode_;
    std::snprintf(s.conversion_badge, sizeof(s.conversion_badge), "%s", badge_.c_str());
    s.volume = volume_;
    std::snprintf(s.error, sizeof(s.error), "%s", error_.c_str());
    return s;
  }

  void setEventCallback(EventFn fn) override { eventFn_ = std::move(fn); }

private:
  void stopInternal() {
    transport_.stop();
    transport_.setSource(nullptr);
    readerSource_.reset();
    path_.clear();
    duration_ = -1;
    state_ = HARBOR_STATE_IDLE;
  }

  void refreshEffective() {
    effectiveMode_ = HARBOR_MODE_SHARED;
    badge_.clear();
    if (requestedMode_ == HARBOR_MODE_SHARED) return;

    bool external = false;
    for (const auto& d : listDevices()) {
      if (!selectedUid_.empty() && d.uid == selectedUid_) {
        external = d.isExternal;
        break;
      }
    }
    if (!external) {
      badge_ = "Shared (no external DAC)";
      return;
    }
    // Exclusive / DoP device hog comes in later todos; Shared graph for now with honest badge.
    if (requestedMode_ == HARBOR_MODE_EXCLUSIVE) {
      effectiveMode_ = HARBOR_MODE_EXCLUSIVE;
      badge_ = "Exclusive (shared graph until hog path)";
    } else if (requestedMode_ == HARBOR_MODE_DOP) {
      effectiveMode_ = HARBOR_MODE_DOP;
      badge_ = "DoP (pending native path)";
    }
  }

  void emit(const char* event, const char* json) {
    if (eventFn_) eventFn_(event, json ? json : "{}");
  }

  void audioDeviceIOCallbackWithContext(const float* const*, int,
                                        float* const* outputChannelData, int numOutputChannels,
                                        int numSamples,
                                        const juce::AudioIODeviceCallbackContext&) override {
    juce::AudioBuffer<float> buffer(outputChannelData, numOutputChannels, numSamples);
    juce::AudioSourceChannelInfo info(buffer);
    if (state_ == HARBOR_STATE_PLAYING) {
      transport_.getNextAudioBlock(info);
    } else {
      buffer.clear();
    }
  }

  void audioDeviceAboutToStart(juce::AudioIODevice* device) override {
    transport_.prepareToPlay(device->getCurrentBufferSizeSamples(), device->getCurrentSampleRate());
  }

  void audioDeviceStopped() override { transport_.releaseResources(); }

  void changeListenerCallback(juce::ChangeBroadcaster*) override {
    if (!transport_.isPlaying() && state_ == HARBOR_STATE_PLAYING
        && transport_.getCurrentPosition() >= duration_ - 0.05) {
      state_ = HARBOR_STATE_IDLE;
      emit("ended", "{}");
      emit("state", nullptr);
    }
  }

  juce::AudioDeviceManager deviceManager_;
  juce::AudioFormatManager formatManager_;
  juce::AudioTransportSource transport_;
  std::unique_ptr<juce::AudioFormatReaderSource> readerSource_;
  EventFn eventFn_;
  std::string path_;
  std::string selectedUid_;
  std::string badge_;
  std::string error_;
  HarborOutputMode requestedMode_ = HARBOR_MODE_SHARED;
  HarborOutputMode effectiveMode_ = HARBOR_MODE_SHARED;
  HarborPlaybackState state_ = HARBOR_STATE_IDLE;
  double duration_ = -1;
  float volume_ = 0.8f;
  int dsdLevel_ = 3;
};

} // namespace

IPlayer* createHarborPlayer() {
  return new JucePlayer();
}

#endif // HARBOR_WITH_JUCE
