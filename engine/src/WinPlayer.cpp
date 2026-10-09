#if defined(_WIN32)

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif

#include "PlaybackFeed.h"
#include "Player.h"

// Include order matters on MSVC. Do NOT include functiondiscoverykeys_devpkey.h —
// its DEFINE_PROPERTYKEY macros clash with the Windows SDK / JUCE include mix in CI.
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <mmreg.h>
#include <propidl.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#ifndef KSDATAFORMAT_SUBTYPE_PCM
// ksmedia.h not always on the include path for cmake-js; GUID literals from Windows SDK
static const GUID kSubtypePcm = {
    0x00000001, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}};
static const GUID kSubtypeFloat = {
    0x00000003, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}};
#define KSDATAFORMAT_SUBTYPE_PCM kSubtypePcm
#define KSDATAFORMAT_SUBTYPE_IEEE_FLOAT kSubtypeFloat
#endif

// Same values as PKEY_Device_FriendlyName / PKEY_Device_EnumeratorName (devpkey.h)
static const PROPERTYKEY kPkeyDeviceFriendlyName = {
    {0xa45c254e, 0xdf1c, 0x4efd, {0x80, 0x20, 0x67, 0xd1, 0x46, 0xa8, 0x50, 0xe0}}, 14};
static const PROPERTYKEY kPkeyDeviceEnumeratorName = {
    {0xa45c254e, 0xdf1c, 0x4efd, {0x80, 0x20, 0x67, 0xd1, 0x46, 0xa8, 0x50, 0xe0}}, 24};

#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "uuid.lib")

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

std::string wideToUtf8(const wchar_t* w) {
  if (!w || !*w) return {};
  const int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
  if (n <= 1) return {};
  std::string out(size_t(n - 1), '\0');
  WideCharToMultiByte(CP_UTF8, 0, w, -1, out.data(), n, nullptr, nullptr);
  return out;
}

std::wstring utf8ToWide(const std::string& s) {
  if (s.empty()) return {};
  const int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, nullptr, 0);
  if (n <= 1) return {};
  std::wstring out(size_t(n - 1), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, out.data(), n);
  return out;
}

class ComInit {
public:
  ComInit() { hr_ = CoInitializeEx(nullptr, COINIT_MULTITHREADED); }
  ~ComInit() {
    if (SUCCEEDED(hr_)) CoUninitialize();
  }
  HRESULT hr() const { return hr_; }

private:
  HRESULT hr_ = E_FAIL;
};

class WinPlayer final : public IPlayer {
public:
  WinPlayer() = default;
  ~WinPlayer() override {
    cancelDecode_();
    stop();
    closeClient_();
  }

  std::vector<PlayerDevice> listDevices() override {
    ComInit com;
    std::vector<PlayerDevice> devices;
    IMMDeviceEnumerator* enumerator = nullptr;
    if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                __uuidof(IMMDeviceEnumerator), (void**)&enumerator)) ||
        !enumerator) {
      devices.push_back({"default", "System Default", false, true, true});
      return devices;
    }

    IMMDevice* defDev = nullptr;
    if (SUCCEEDED(enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &defDev)) && defDev) {
      PlayerDevice d = describeDevice_(defDev, true);
      devices.push_back(std::move(d));
      defDev->Release();
    }

    IMMDeviceCollection* coll = nullptr;
    if (SUCCEEDED(enumerator->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &coll)) && coll) {
      UINT count = 0;
      coll->GetCount(&count);
      for (UINT i = 0; i < count; ++i) {
        IMMDevice* dev = nullptr;
        if (FAILED(coll->Item(i, &dev)) || !dev) continue;
        PlayerDevice d = describeDevice_(dev, false);
        // skip duplicate of default if same id
        bool dup = false;
        for (const auto& existing : devices) {
          if (existing.uid == d.uid) {
            dup = true;
            break;
          }
        }
        if (!dup) devices.push_back(std::move(d));
        dev->Release();
      }
      coll->Release();
    }
    enumerator->Release();

    if (devices.empty()) {
      devices.push_back({"default", "System Default", false, true, true});
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
    frameIndex_ = 0;
    sampleRate_ = 44100;
    channels_ = 2;

    const bool isDsd = endsWithCi(path, ".dsf") || endsWithCi(path, ".dff");
    refreshEffective_();
    if (!isDsd && effectiveMode_ == HARBOR_MODE_DOP) {
      badge_ = "Shared (DoP needs DSD)";
      effectiveMode_ = HARBOR_MODE_SHARED;
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
      badge_ = "DoP · WASAPI Exclusive";
      cancelDecodeFlag_.store(false);
      feed_.startDopFill(dop_, readyFrames_, cancelDecodeFlag_);
    } else {
      if (isDsd) {
        badge_ = effectiveMode_ == HARBOR_MODE_EXCLUSIVE ? "Exclusive · DSD→PCM"
                                                         : "Shared · DSD→PCM";
      } else if (effectiveMode_ == HARBOR_MODE_EXCLUSIVE) {
        badge_ = "Exclusive · WASAPI";
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

    if (!openClient_()) {
      cancelDecode_();
      if (error_.empty()) error_ = "WASAPI open failed";
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
      if (client_) client_->Stop();
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
  PlayerDevice describeDevice_(IMMDevice* dev, bool isDefault) {
    PlayerDevice d;
    d.supportsExclusive = true;
    d.supportsDop = true;
    LPWSTR id = nullptr;
    if (SUCCEEDED(dev->GetId(&id)) && id) {
      d.uid = wideToUtf8(id);
      CoTaskMemFree(id);
    }
    if (isDefault && d.uid.empty()) d.uid = "default";
    if (isDefault && d.uid != "default") {
      // keep real id; also expose friendly default name
    }
    IPropertyStore* props = nullptr;
    if (SUCCEEDED(dev->OpenPropertyStore(STGM_READ, &props)) && props) {
      PROPVARIANT var;
      PropVariantInit(&var);
      if (SUCCEEDED(props->GetValue(kPkeyDeviceFriendlyName, &var)) && var.vt == VT_LPWSTR) {
        d.name = wideToUtf8(var.pwszVal);
      }
      PropVariantClear(&var);
      PropVariantInit(&var);
      if (SUCCEEDED(props->GetValue(kPkeyDeviceEnumeratorName, &var)) && var.vt == VT_LPWSTR) {
        const std::string en = wideToUtf8(var.pwszVal);
        d.isExternal = en == "USB" || en == "HDAudio" || en == "PCI";
      }
      PropVariantClear(&var);
      props->Release();
    }
    if (d.name.empty()) d.name = isDefault ? "System Default" : d.uid;
    if (isDefault) d.name = "Default · " + d.name;
    return d;
  }

  void refreshEffective_() {
    effectiveMode_ = HARBOR_MODE_SHARED;
    badge_.clear();
    if (requestedMode_ == HARBOR_MODE_SHARED) return;
    // WASAPI Exclusive/DoP available on endpoint devices
    effectiveMode_ = requestedMode_;
  }

  IMMDevice* resolveDevice_() {
    IMMDeviceEnumerator* enumerator = nullptr;
    if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                __uuidof(IMMDeviceEnumerator), (void**)&enumerator)) ||
        !enumerator) {
      return nullptr;
    }
    IMMDevice* device = nullptr;
    if (selectedUid_.empty() || selectedUid_ == "default") {
      enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device);
    } else {
      const std::wstring wid = utf8ToWide(selectedUid_);
      enumerator->GetDevice(wid.c_str(), &device);
      if (!device) {
        enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device);
      }
    }
    enumerator->Release();
    return device;
  }

  void fillExtensible_(WAVEFORMATEXTENSIBLE& wfx, WORD tag, WORD bits, DWORD rate, WORD ch) {
    std::memset(&wfx, 0, sizeof(wfx));
    wfx.Format.wFormatTag = WAVE_FORMAT_EXTENSIBLE;
    wfx.Format.nChannels = ch;
    wfx.Format.nSamplesPerSec = rate;
    wfx.Format.wBitsPerSample = bits;
    wfx.Format.nBlockAlign = WORD((ch * bits) / 8);
    wfx.Format.nAvgBytesPerSec = wfx.Format.nSamplesPerSec * wfx.Format.nBlockAlign;
    wfx.Format.cbSize = 22;
    wfx.Samples.wValidBitsPerSample = bits;
    wfx.dwChannelMask = ch >= 2 ? (SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT) : SPEAKER_FRONT_CENTER;
    if (tag == WAVE_FORMAT_IEEE_FLOAT) {
      wfx.SubFormat = KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
    } else {
      wfx.SubFormat = KSDATAFORMAT_SUBTYPE_PCM;
    }
  }

  IAudioClient* activateClient_(IMMDevice* device) {
    IAudioClient* client = nullptr;
    if (FAILED(device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, (void**)&client))) {
      return nullptr;
    }
    return client;
  }

  bool initShared_(IMMDevice* device) {
    IAudioClient* client = activateClient_(device);
    if (!client) return false;
    WAVEFORMATEX* mix = nullptr;
    if (FAILED(client->GetMixFormat(&mix)) || !mix) {
      client->Release();
      return false;
    }
    const REFERENCE_TIME bufferDuration = 10000000; // 1s
    const HRESULT hr =
        client->Initialize(AUDCLNT_SHAREMODE_SHARED, 0, bufferDuration, 0, mix, nullptr);
    if (FAILED(hr)) {
      CoTaskMemFree(mix);
      client->Release();
      return false;
    }
    useFloat_ = (mix->wFormatTag == WAVE_FORMAT_IEEE_FLOAT) ||
                (mix->wFormatTag == WAVE_FORMAT_EXTENSIBLE &&
                 reinterpret_cast<WAVEFORMATEXTENSIBLE*>(mix)->SubFormat ==
                     KSDATAFORMAT_SUBTYPE_IEEE_FLOAT);
    bitsPerSample_ = mix->wBitsPerSample;
    channels_ = mix->nChannels;
    sampleRate_ = mix->nSamplesPerSec;
    CoTaskMemFree(mix);
    return finishOpen_(client);
  }

  bool initExclusive_(IMMDevice* device, WAVEFORMATEXTENSIBLE& wfx) {
    IAudioClient* client = activateClient_(device);
    if (!client) return false;
    REFERENCE_TIME defPeriod = 0, minPeriod = 0;
    client->GetDevicePeriod(&defPeriod, &minPeriod);
    if (minPeriod <= 0) minPeriod = 100000; // 10ms

    HRESULT hr =
        client->Initialize(AUDCLNT_SHAREMODE_EXCLUSIVE, 0, minPeriod, minPeriod, &wfx.Format, nullptr);
    if (FAILED(hr)) {
      client->Release();
      // retry with default period
      client = activateClient_(device);
      if (!client) return false;
      hr = client->Initialize(AUDCLNT_SHAREMODE_EXCLUSIVE, 0, defPeriod > 0 ? defPeriod : minPeriod,
                              defPeriod > 0 ? defPeriod : minPeriod, &wfx.Format, nullptr);
      if (FAILED(hr)) {
        client->Release();
        return false;
      }
    }
    useFloat_ = (wfx.SubFormat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT);
    bitsPerSample_ = wfx.Format.wBitsPerSample;
    return finishOpen_(client);
  }

  bool finishOpen_(IAudioClient* client) {
    IAudioRenderClient* render = nullptr;
    if (FAILED(client->GetService(__uuidof(IAudioRenderClient), (void**)&render)) || !render) {
      client->Release();
      return false;
    }
    UINT32 bufferFrames = 0;
    client->GetBufferSize(&bufferFrames);
    bufferFrames_ = bufferFrames;
    client_ = client;
    render_ = render;
    return true;
  }

  bool openClient_() {
    closeClient_();
    ComInit com;
    if (FAILED(com.hr()) && com.hr() != RPC_E_CHANGED_MODE) {
      error_ = "COM init failed";
      return false;
    }

    IMMDevice* device = resolveDevice_();
    if (!device) {
      error_ = "No WASAPI render device";
      return false;
    }

    const bool wantExclusive =
        effectiveMode_ == HARBOR_MODE_EXCLUSIVE || effectiveMode_ == HARBOR_MODE_DOP;
    WAVEFORMATEXTENSIBLE wfx {};
    bool ok = false;

    if (isDop_) {
      fillExtensible_(wfx, WAVE_FORMAT_PCM, 32, sampleRate_, channels_);
      ok = initExclusive_(device, wfx);
      if (!ok) {
        fillExtensible_(wfx, WAVE_FORMAT_PCM, 24, sampleRate_, channels_);
        ok = initExclusive_(device, wfx);
      }
      if (!ok) {
        device->Release();
        error_ = "DoP needs WASAPI Exclusive at DoP rate";
        effectiveMode_ = HARBOR_MODE_SHARED;
        badge_ = "Shared (DoP unsupported on device)";
        return false;
      }
      useFloat_ = false;
    } else if (wantExclusive) {
      fillExtensible_(wfx, WAVE_FORMAT_IEEE_FLOAT, 32, sampleRate_, channels_);
      ok = initExclusive_(device, wfx);
      if (!ok) {
        fillExtensible_(wfx, WAVE_FORMAT_PCM, 32, sampleRate_, channels_);
        ok = initExclusive_(device, wfx);
      }
      if (!ok) {
        fillExtensible_(wfx, WAVE_FORMAT_PCM, 16, sampleRate_, channels_);
        ok = initExclusive_(device, wfx);
      }
      if (!ok) {
        effectiveMode_ = HARBOR_MODE_SHARED;
        badge_ = "Shared (Exclusive format rejected)";
        ok = initShared_(device);
      }
    } else {
      ok = initShared_(device);
    }

    device->Release();
    if (!ok) {
      error_ = "WASAPI Initialize failed";
      return false;
    }
    return true;
  }

  void closeClient_() {
    if (client_) {
      client_->Stop();
      client_->Release();
      client_ = nullptr;
    }
    if (render_) {
      render_->Release();
      render_ = nullptr;
    }
    bufferFrames_ = 0;
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
    closeClient_();
    path_.clear();
    pcm_.clear();
    dop_.clear();
    readyFrames_.store(0);
    totalFrames_.store(0);
    frameIndex_ = 0;
    duration_ = -1;
  }

  void writeFrames_(BYTE* data, UINT32 frames) {
    if (frames == 0) return;
    size_t idx = frameIndex_.load();
    const size_t ready = readyFrames_.load(std::memory_order_acquire);
    const size_t total = totalFrames_.load(std::memory_order_acquire);
    size_t advanced = 0;
    if (isDop_) {
      for (UINT32 f = 0; f < frames; ++f) {
        for (uint16_t c = 0; c < channels_; ++c) {
          int32_t sample = 0;
          if (idx + f < ready) sample = dop_[(idx + f) * channels_ + c];
          if (bitsPerSample_ <= 16) {
            reinterpret_cast<int16_t*>(data)[f * channels_ + c] = int16_t(sample >> 16);
          } else {
            reinterpret_cast<int32_t*>(data)[f * channels_ + c] = sample;
          }
        }
        if (idx + f < ready) ++advanced;
        else if (total > 0 && idx + f >= total) ++advanced;
      }
      frameIndex_.store(idx + advanced);
      return;
    }

    for (UINT32 f = 0; f < frames; ++f) {
      for (uint16_t c = 0; c < channels_; ++c) {
        float sample = 0.f;
        if (idx + f < ready) sample = pcm_[(idx + f) * channels_ + c] * volume_;
        if (useFloat_) {
          reinterpret_cast<float*>(data)[f * channels_ + c] = sample;
        } else if (bitsPerSample_ <= 16) {
          const float clamped = std::max(-1.f, std::min(1.f, sample));
          reinterpret_cast<int16_t*>(data)[f * channels_ + c] =
              int16_t(clamped * 32767.f);
        } else {
          const float clamped = std::max(-1.f, std::min(1.f, sample));
          reinterpret_cast<int32_t*>(data)[f * channels_ + c] =
              int32_t(clamped * 2147483647.f);
        }
      }
      if (idx + f < ready) ++advanced;
      else if (total > 0 && idx + f >= total) ++advanced;
    }
    frameIndex_.store(idx + advanced);
  }

  bool ended_() const {
    const size_t total = totalFrames_.load(std::memory_order_acquire);
    return total > 0 && frameIndex_.load() >= total;
  }

  void ensureThread_() {
    if (threadRunning_) return;
    threadRunning_ = true;
    std::thread([this] {
      ComInit com;
      while (true) {
        HarborPlaybackState st;
        IAudioClient* client = nullptr;
        IAudioRenderClient* render = nullptr;
        UINT32 bufferFrames = 0;
        {
          std::lock_guard lock(mutex_);
          st = state_;
          client = client_;
          render = render_;
          bufferFrames = bufferFrames_;
          if (st != HARBOR_STATE_PLAYING || !client || !render) {
            threadRunning_ = false;
            break;
          }
        }

        if (ended_()) {
          std::lock_guard lock(mutex_);
          state_ = HARBOR_STATE_IDLE;
          if (client_) client_->Stop();
          emit_("ended", "{}");
          emit_("state", nullptr);
          threadRunning_ = false;
          break;
        }

        const size_t idx = frameIndex_.load();
        const size_t ready = readyFrames_.load(std::memory_order_acquire);
        const size_t total = totalFrames_.load(std::memory_order_acquire);
        if (idx >= ready && (total == 0 || idx < total)) {
          std::this_thread::sleep_for(std::chrono::milliseconds(2));
          continue;
        }

        client->Start();
        UINT32 padding = 0;
        if (FAILED(client->GetCurrentPadding(&padding))) {
          std::this_thread::sleep_for(std::chrono::milliseconds(5));
          continue;
        }
        const UINT32 available = bufferFrames > padding ? bufferFrames - padding : 0;
        if (available == 0) {
          std::this_thread::sleep_for(std::chrono::milliseconds(2));
          continue;
        }
        BYTE* data = nullptr;
        if (FAILED(render->GetBuffer(available, &data)) || !data) {
          std::this_thread::sleep_for(std::chrono::milliseconds(2));
          continue;
        }
        writeFrames_(data, available);
        render->ReleaseBuffer(available, 0);

        if (ended_()) {
          std::lock_guard lock(mutex_);
          state_ = HARBOR_STATE_IDLE;
          client->Stop();
          emit_("ended", "{}");
          emit_("state", nullptr);
          threadRunning_ = false;
          break;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(2));
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
  bool useFloat_ = true;
  WORD bitsPerSample_ = 32;
  std::vector<float> pcm_;
  std::vector<int32_t> dop_;
  PlaybackFeed feed_;
  std::atomic<size_t> frameIndex_ { 0 };
  std::atomic<size_t> readyFrames_ { 0 };
  std::atomic<size_t> totalFrames_ { 0 };
  std::atomic<bool> cancelDecodeFlag_ { false };
  IAudioClient* client_ = nullptr;
  IAudioRenderClient* render_ = nullptr;
  UINT32 bufferFrames_ = 0;
  bool threadRunning_ = false;
};

} // namespace

IPlayer* createWinPlayer() {
  return new WinPlayer();
}

#endif // _WIN32
