#if defined(__APPLE__)

#include "DsdPipeline.h"
#include "Player.h"

#include <AudioToolbox/AudioToolbox.h>
#include <CoreAudio/CoreAudio.h>

#include <algorithm>
#include <atomic>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <unistd.h>
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
} // namespace

namespace {

class MacPlayer final : public IPlayer {
public:
  MacPlayer() = default;
  ~MacPlayer() override { stop(); releaseHog(); }

  std::vector<PlayerDevice> listDevices() override {
    std::vector<PlayerDevice> devices;
    AudioObjectPropertyAddress addr {
      kAudioHardwarePropertyDevices,
      kAudioObjectPropertyScopeGlobal,
      kAudioObjectPropertyElementMain
    };
    UInt32 size = 0;
    AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &addr, 0, nullptr, &size);
    const auto count = size / sizeof(AudioDeviceID);
    std::vector<AudioDeviceID> ids(count);
    if (count) {
      AudioObjectGetPropertyData(kAudioObjectSystemObject, &addr, 0, nullptr, &size, ids.data());
    }
    for (auto id : ids) {
      AudioObjectPropertyAddress outAddr {
        kAudioDevicePropertyStreams,
        kAudioDevicePropertyScopeOutput,
        kAudioObjectPropertyElementMain
      };
      UInt32 streamSize = 0;
      if (AudioObjectGetPropertyDataSize(id, &outAddr, 0, nullptr, &streamSize) != noErr || !streamSize)
        continue;

      PlayerDevice d;
      d.uid = std::to_string(id);
      CFStringRef nameRef = nullptr;
      UInt32 nameSize = sizeof(nameRef);
      AudioObjectPropertyAddress nameAddr {
        kAudioObjectPropertyName, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain
      };
      if (AudioObjectGetPropertyData(id, &nameAddr, 0, nullptr, &nameSize, &nameRef) == noErr && nameRef) {
        char buf[256] {};
        CFStringGetCString(nameRef, buf, sizeof(buf), kCFStringEncodingUTF8);
        d.name = buf;
        CFRelease(nameRef);
      } else d.name = "Device " + d.uid;

      AudioObjectPropertyAddress transportAddr {
        kAudioDevicePropertyTransportType, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain
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
    if (devices.empty()) {
      devices.push_back({"default", "System Default", false, false, false});
    }
    return devices;
  }

  void setDevice(const std::string* uidOrNull) override {
    std::lock_guard lock(mutex_);
    selectedUid_ = uidOrNull ? *uidOrNull : std::string();
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
    stopUnlocked_();
    std::lock_guard lock(mutex_);
    path_ = path;
    state_ = HARBOR_STATE_LOADING;
    error_.clear();
    pcm_.clear();
    dop_.clear();
    isDop_ = false;
    sampleRate_ = 44100;
    channels_ = 2;
    frameIndex_ = 0;

    const bool isDsd = endsWithCi(path, ".dsf") || endsWithCi(path, ".dff");
    if (isDsd) {
      DsdStream dsd;
      std::string err;
      if (!loadDsdFile(path, dsd, err)) {
        error_ = err;
        state_ = HARBOR_STATE_FAILED;
        emit_("state", nullptr);
        return false;
      }
      channels_ = dsd.channels;
      refreshEffective_();
      if (effectiveMode_ == HARBOR_MODE_DOP) {
        packDop(dsd, dop_, sampleRate_);
        isDop_ = true;
        badge_ = "DoP";
        duration_ = double(dop_.size() / channels_) / double(sampleRate_);
      } else {
        dsdToPcm(dsd, pcm_, sampleRate_, float(dsdLevel_));
        isDop_ = false;
        badge_ = effectiveMode_ == HARBOR_MODE_EXCLUSIVE
                   ? "Exclusive · DSD→PCM"
                   : "Shared · DSD→PCM";
        duration_ = double(pcm_.size() / channels_) / double(sampleRate_);
      }
    } else {
      if (!loadPcmFile_(path)) {
        state_ = HARBOR_STATE_FAILED;
        emit_("state", nullptr);
        return false;
      }
      refreshEffective_();
      if (effectiveMode_ == HARBOR_MODE_EXCLUSIVE) badge_ = "Exclusive";
      else if (effectiveMode_ == HARBOR_MODE_DOP) {
        effectiveMode_ = HARBOR_MODE_EXCLUSIVE;
        badge_ = "Exclusive (PCM, DoP N/A)";
      } else badge_.clear();
    }

    if (!openUnit_()) {
      error_ = "Failed to open audio unit";
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
    if (!audioUnit_) return;
    AudioOutputUnitStart(audioUnit_);
    state_ = HARBOR_STATE_PLAYING;
    emit_("state", nullptr);
  }

  void pause() override {
    std::lock_guard lock(mutex_);
    if (audioUnit_) AudioOutputUnitStop(audioUnit_);
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
    setHardwareVolume_(volume_);
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
  bool loadPcmFile_(const std::string& path) {
    CFURLRef url = CFURLCreateFromFileSystemRepresentation(
      kCFAllocatorDefault, reinterpret_cast<const UInt8*>(path.c_str()), path.size(), false);
    if (!url) {
      error_ = "Bad path";
      return false;
    }
    ExtAudioFileRef eaf = nullptr;
    OSStatus st = ExtAudioFileOpenURL(url, &eaf);
    CFRelease(url);
    if (st != noErr || !eaf) {
      error_ = "Cannot open audio file";
      return false;
    }

    AudioStreamBasicDescription fileFmt {};
    UInt32 size = sizeof(fileFmt);
    ExtAudioFileGetProperty(eaf, kExtAudioFileProperty_FileDataFormat, &size, &fileFmt);

    AudioStreamBasicDescription client = fileFmt;
    client.mFormatID = kAudioFormatLinearPCM;
    client.mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked | kAudioFormatFlagsNativeEndian;
    client.mBitsPerChannel = 32;
    client.mChannelsPerFrame = fileFmt.mChannelsPerFrame ? fileFmt.mChannelsPerFrame : 2;
    client.mBytesPerFrame = 4 * client.mChannelsPerFrame;
    client.mFramesPerPacket = 1;
    client.mBytesPerPacket = client.mBytesPerFrame;
    ExtAudioFileSetProperty(eaf, kExtAudioFileProperty_ClientDataFormat, sizeof(client), &client);

    sampleRate_ = uint32_t(client.mSampleRate);
    channels_ = uint16_t(client.mChannelsPerFrame);

    SInt64 frames = 0;
    size = sizeof(frames);
    ExtAudioFileGetProperty(eaf, kExtAudioFileProperty_FileLengthFrames, &size, &frames);
    pcm_.resize(size_t(frames) * channels_);
    AudioBufferList abl {};
    abl.mNumberBuffers = 1;
    abl.mBuffers[0].mNumberChannels = channels_;
    abl.mBuffers[0].mDataByteSize = UInt32(pcm_.size() * sizeof(float));
    abl.mBuffers[0].mData = pcm_.data();
    UInt32 framesToRead = UInt32(frames);
    ExtAudioFileRead(eaf, &framesToRead, &abl);
    ExtAudioFileDispose(eaf);
    duration_ = double(framesToRead) / double(sampleRate_);
    isDop_ = false;
    return true;
  }

  AudioDeviceID selectedDeviceId_() const {
    if (selectedUid_.empty() || selectedUid_ == "default") {
      AudioDeviceID id = kAudioObjectUnknown;
      UInt32 size = sizeof(id);
      AudioObjectPropertyAddress addr {
        kAudioHardwarePropertyDefaultOutputDevice,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
      };
      AudioObjectGetPropertyData(kAudioObjectSystemObject, &addr, 0, nullptr, &size, &id);
      return id;
    }
    return AudioDeviceID(std::stoul(selectedUid_));
  }

  bool deviceIsExternal_(AudioDeviceID id) const {
    AudioObjectPropertyAddress transportAddr {
      kAudioDevicePropertyTransportType, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain
    };
    UInt32 transport = 0;
    UInt32 tSize = sizeof(transport);
    if (AudioObjectGetPropertyData(id, &transportAddr, 0, nullptr, &tSize, &transport) != noErr)
      return false;
    return transport == kAudioDeviceTransportTypeUSB
        || transport == kAudioDeviceTransportTypeFireWire
        || transport == kAudioDeviceTransportTypeThunderbolt
        || transport == kAudioDeviceTransportTypePCI;
  }

  void refreshEffective_() {
    effectiveMode_ = HARBOR_MODE_SHARED;
    badge_.clear();
    if (requestedMode_ == HARBOR_MODE_SHARED) return;
    const auto id = selectedDeviceId_();
    if (!deviceIsExternal_(id)) {
      badge_ = "Shared (no external DAC)";
      return;
    }
    effectiveMode_ = requestedMode_;
  }

  void claimHog_(AudioDeviceID id) {
    releaseHog();
    pid_t pid = getpid();
    AudioObjectPropertyAddress hogAddr {
      kAudioDevicePropertyHogMode, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain
    };
    AudioObjectSetPropertyData(id, &hogAddr, 0, nullptr, sizeof(pid), &pid);
    hoggedId_ = id;

    AudioObjectPropertyAddress rateAddr {
      kAudioDevicePropertyNominalSampleRate, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain
    };
    Float64 rate = sampleRate_;
    AudioObjectSetPropertyData(id, &rateAddr, 0, nullptr, sizeof(rate), &rate);
  }

  void releaseHog() {
    if (hoggedId_ == kAudioObjectUnknown) return;
    pid_t release = -1;
    AudioObjectPropertyAddress hogAddr {
      kAudioDevicePropertyHogMode, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain
    };
    AudioObjectSetPropertyData(hoggedId_, &hogAddr, 0, nullptr, sizeof(release), &release);
    hoggedId_ = kAudioObjectUnknown;
  }

  bool openUnit_() {
    closeUnit_();
    AudioComponentDescription desc {};
    desc.componentType = kAudioUnitType_Output;
    desc.componentSubType = kAudioUnitSubType_HALOutput;
    desc.componentManufacturer = kAudioUnitManufacturer_Apple;
    AudioComponent comp = AudioComponentFindNext(nullptr, &desc);
    if (!comp) return false;
    if (AudioComponentInstanceNew(comp, &audioUnit_) != noErr) return false;

    UInt32 enableIO = 1;
    AudioUnitSetProperty(audioUnit_, kAudioOutputUnitProperty_EnableIO,
                         kAudioUnitScope_Output, 0, &enableIO, sizeof(enableIO));
    enableIO = 0;
    AudioUnitSetProperty(audioUnit_, kAudioOutputUnitProperty_EnableIO,
                         kAudioUnitScope_Input, 1, &enableIO, sizeof(enableIO));

    AudioDeviceID device = selectedDeviceId_();
    AudioUnitSetProperty(audioUnit_, kAudioOutputUnitProperty_CurrentDevice,
                         kAudioUnitScope_Global, 0, &device, sizeof(device));

    if (effectiveMode_ == HARBOR_MODE_EXCLUSIVE || effectiveMode_ == HARBOR_MODE_DOP) {
      claimHog_(device);
    }

    AudioStreamBasicDescription asbd {};
    asbd.mSampleRate = sampleRate_;
    asbd.mFormatID = kAudioFormatLinearPCM;
    asbd.mChannelsPerFrame = channels_;
    asbd.mFramesPerPacket = 1;
    if (isDop_) {
      asbd.mFormatFlags = kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked | kAudioFormatFlagsNativeEndian;
      asbd.mBitsPerChannel = 24;
      asbd.mBytesPerFrame = 4 * channels_; // 32-bit container
      asbd.mBytesPerPacket = asbd.mBytesPerFrame;
    } else {
      asbd.mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked | kAudioFormatFlagsNativeEndian;
      asbd.mBitsPerChannel = 32;
      asbd.mBytesPerFrame = 4 * channels_;
      asbd.mBytesPerPacket = asbd.mBytesPerFrame;
    }
    AudioUnitSetProperty(audioUnit_, kAudioUnitProperty_StreamFormat,
                         kAudioUnitScope_Input, 0, &asbd, sizeof(asbd));

    AURenderCallbackStruct cb {};
    cb.inputProc = &MacPlayer::render_;
    cb.inputProcRefCon = this;
    AudioUnitSetProperty(audioUnit_, kAudioUnitProperty_SetRenderCallback,
                         kAudioUnitScope_Input, 0, &cb, sizeof(cb));
    return AudioUnitInitialize(audioUnit_) == noErr;
  }

  void closeUnit_() {
    if (!audioUnit_) return;
    AudioOutputUnitStop(audioUnit_);
    AudioUnitUninitialize(audioUnit_);
    AudioComponentInstanceDispose(audioUnit_);
    audioUnit_ = nullptr;
    releaseHog();
  }

  void stopUnlocked_() {
    closeUnit_();
    path_.clear();
    pcm_.clear();
    dop_.clear();
    frameIndex_ = 0;
    duration_ = -1;
    state_ = HARBOR_STATE_IDLE;
  }

  void setHardwareVolume_(float level) {
    auto id = selectedDeviceId_();
    AudioObjectPropertyAddress volAddr {
      kAudioDevicePropertyVolumeScalar,
      kAudioDevicePropertyScopeOutput,
      kAudioObjectPropertyElementMain
    };
    Float32 v = level;
    AudioObjectSetPropertyData(id, &volAddr, 0, nullptr, sizeof(v), &v);
  }

  void emit_(const char* event, const char* json) {
    if (eventFn_) eventFn_(event, json ? json : "{}");
  }

  static OSStatus render_(void* ref, AudioUnitRenderActionFlags*, const AudioTimeStamp*,
                          UInt32, UInt32 inNumberFrames, AudioBufferList* ioData) {
    auto* self = static_cast<MacPlayer*>(ref);
    if (!ioData || !ioData->mNumberBuffers) return noErr;
    auto& buf = ioData->mBuffers[0];
    const size_t ch = self->channels_;
    size_t idx = self->frameIndex_.load();

    if (self->isDop_) {
      auto* out = static_cast<int32_t*>(buf.mData);
      const size_t totalFrames = self->dop_.size() / ch;
      for (UInt32 i = 0; i < inNumberFrames; ++i) {
        if (idx >= totalFrames) {
          for (size_t c = 0; c < ch; ++c) out[i * ch + c] = 0;
          continue;
        }
        for (size_t c = 0; c < ch; ++c) out[i * ch + c] = self->dop_[idx * ch + c];
        ++idx;
      }
    } else {
      auto* out = static_cast<float*>(buf.mData);
      const size_t totalFrames = self->pcm_.size() / ch;
      for (UInt32 i = 0; i < inNumberFrames; ++i) {
        if (idx >= totalFrames) {
          for (size_t c = 0; c < ch; ++c) out[i * ch + c] = 0.0f;
          continue;
        }
        for (size_t c = 0; c < ch; ++c) out[i * ch + c] = self->pcm_[idx * ch + c];
        ++idx;
      }
    }
    self->frameIndex_.store(idx);
    const size_t total = self->isDop_ ? self->dop_.size() / ch : self->pcm_.size() / ch;
    if (idx >= total && self->state_ == HARBOR_STATE_PLAYING) {
      self->state_ = HARBOR_STATE_IDLE;
      self->emit_("ended", "{}");
      self->emit_("state", nullptr);
    }
    return noErr;
  }

  std::mutex mutex_;
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
  uint32_t sampleRate_ = 44100;
  uint16_t channels_ = 2;
  bool isDop_ = false;
  std::vector<float> pcm_;
  std::vector<int32_t> dop_;
  std::atomic<size_t> frameIndex_ { 0 };
  AudioUnit audioUnit_ = nullptr;
  AudioDeviceID hoggedId_ = kAudioObjectUnknown;
};

} // namespace

IPlayer* createHarborPlayer() {
  return new MacPlayer();
}

#endif // __APPLE__
