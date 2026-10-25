// Audio Units (macOS): the effects the Mac already has — AUv2 components in this process
// (harbor-fx is the isolation), AUv3 extensions out of process.
#include "FxPlugin.h"

#include <AudioToolbox/AudioToolbox.h>
#include <CoreFoundation/CoreFoundation.h>
#include <dispatch/dispatch.h>

#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

namespace {

constexpr OSType kTypes[] = {kAudioUnitType_Effect, kAudioUnitType_MusicEffect};
/** An AUv3 that does not answer in this long is treated as not there. */
constexpr int64_t kInstantiateTimeoutNs = 10LL * 1000 * 1000 * 1000;

std::string fromCF(CFStringRef s) {
  if (!s) return {};
  char buf[512];
  if (CFStringGetCString(s, buf, sizeof(buf), kCFStringEncodingUTF8)) return buf;
  return {};
}

/** "aufx-6e626571-6170706c": type, subtype, manufacturer — stable across launches. */
std::string idOf(const AudioComponentDescription& d) {
  char buf[40];
  std::snprintf(buf, sizeof(buf), "%08x-%08x-%08x", unsigned(d.componentType), unsigned(d.componentSubType),
                unsigned(d.componentManufacturer));
  return buf;
}

bool parseId(const std::string& id, AudioComponentDescription& d) {
  unsigned t = 0, s = 0, m = 0;
  if (std::sscanf(id.c_str(), "%8x-%8x-%8x", &t, &s, &m) != 3) return false;
  d = AudioComponentDescription {OSType(t), OSType(s), OSType(m), 0, 0};
  return true;
}

/** "Manufacturer: Name" as Core Audio names components. */
void splitName(const std::string& full, std::string& vendor, std::string& name) {
  const size_t colon = full.find(": ");
  if (colon == std::string::npos) {
    name = full;
    return;
  }
  vendor = full.substr(0, colon);
  name = full.substr(colon + 2);
}

std::string versionOf(UInt32 v) {
  char buf[32];
  std::snprintf(buf, sizeof(buf), "%u.%u.%u", (v >> 16) & 0xffff, (v >> 8) & 0xff, v & 0xff);
  return buf;
}

FxDescriptor describeComponent(AudioComponent comp) {
  AudioComponentDescription desc {};
  AudioComponentGetDescription(comp, &desc);
  FxDescriptor d;
  d.format = "au";
  d.id = idOf(desc);
  CFStringRef name = nullptr;
  if (AudioComponentCopyName(comp, &name) == noErr) {
    splitName(fromCF(name), d.vendor, d.name);
    CFRelease(name);
  }
  UInt32 version = 0;
  if (AudioComponentGetVersion(comp, &version) == noErr) d.version = versionOf(version);
  d.features.push_back(desc.componentType == kAudioUnitType_MusicEffect ? "music-effect" : "audio-effect");
  if (desc.componentFlags & kAudioComponentFlag_IsV3AudioUnit) d.features.push_back("auv3");
  return d;
}

/** AUv2 in this process, at once; AUv3 out of process, waited for. */
AudioComponentInstance instantiate(AudioComponent comp, std::string& error) {
  AudioComponentDescription desc {};
  AudioComponentGetDescription(comp, &desc);
  if (!(desc.componentFlags & kAudioComponentFlag_IsV3AudioUnit)) {
    AudioComponentInstance unit = nullptr;
    if (AudioComponentInstanceNew(comp, &unit) != noErr || !unit) {
      error = "The Audio Unit could not be opened";
      return nullptr;
    }
    return unit;
  }
  __block AudioComponentInstance result = nullptr;
  __block OSStatus status = noErr;
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  AudioComponentInstantiate(comp, kAudioComponentInstantiation_LoadOutOfProcess,
                            ^(AudioComponentInstance unit, OSStatus err) {
                              result = unit;
                              status = err;
                              dispatch_semaphore_signal(done);
                            });
  const bool answered = dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, kInstantiateTimeoutNs)) == 0;
  if (!answered || status != noErr || !result) {
    error = answered ? "The Audio Unit extension could not be opened" : "The Audio Unit extension did not answer";
    return nullptr;
  }
  return result;
}

AudioStreamBasicDescription floatFormat(double rate, UInt32 channels) {
  AudioStreamBasicDescription f {};
  f.mSampleRate = rate;
  f.mFormatID = kAudioFormatLinearPCM;
  f.mFormatFlags = kAudioFormatFlagsNativeFloatPacked | kAudioFormatFlagIsNonInterleaved;
  f.mBytesPerPacket = sizeof(float);
  f.mFramesPerPacket = 1;
  f.mBytesPerFrame = sizeof(float);
  f.mChannelsPerFrame = channels;
  f.mBitsPerChannel = 32;
  return f;
}

/** Stereo in and out at `rate`, the most frames per slice set, then initialized. */
bool configure(AudioComponentInstance unit, double rate, UInt32 maxBlock) {
  const AudioStreamBasicDescription f = floatFormat(rate, 2);
  for (AudioUnitScope scope : {kAudioUnitScope_Input, kAudioUnitScope_Output}) {
    if (AudioUnitSetProperty(unit, kAudioUnitProperty_StreamFormat, scope, 0, &f, sizeof(f)) != noErr) return false;
  }
  AudioUnitSetProperty(unit, kAudioUnitProperty_MaximumFramesPerSlice, kAudioUnitScope_Global, 0, &maxBlock,
                       sizeof(maxBlock));
  return AudioUnitInitialize(unit) == noErr;
}

const char* unitSymbol(AudioUnitParameterUnit unit) {
  switch (unit) {
    case kAudioUnitParameterUnit_Decibels: return "dB";
    case kAudioUnitParameterUnit_Hertz: return "Hz";
    case kAudioUnitParameterUnit_Percent: return "%";
    case kAudioUnitParameterUnit_Milliseconds: return "ms";
    case kAudioUnitParameterUnit_Seconds: return "s";
    case kAudioUnitParameterUnit_Cents:
    case kAudioUnitParameterUnit_AbsoluteCents: return "ct";
    case kAudioUnitParameterUnit_Octaves: return "oct";
    case kAudioUnitParameterUnit_RelativeSemiTones: return "st";
    case kAudioUnitParameterUnit_Degrees:
    case kAudioUnitParameterUnit_Phase: return "°";
    case kAudioUnitParameterUnit_BPM: return "BPM";
    case kAudioUnitParameterUnit_Ratio:
    case kAudioUnitParameterUnit_Rate: return "x";
    default: return "";
  }
}

class AuPlugin final : public FxPlugin {
public:
  explicit AuPlugin(AudioComponentInstance unit) : unit_(unit) {
    AURenderCallbackStruct cb {&AuPlugin::pullInput, this};
    AudioUnitSetProperty(unit_, kAudioUnitProperty_SetRenderCallback, kAudioUnitScope_Input, 0, &cb, sizeof(cb));
  }

  ~AuPlugin() override {
    deactivate();
    AudioComponentInstanceDispose(unit_);
  }

  bool activate(double rate, uint32_t maxBlock, std::string& error) override {
    deactivate();
    if (!configure(unit_, rate, maxBlock)) {
      error = "The Audio Unit does not take stereo at " + std::to_string(int(rate)) + " Hz";
      return false;
    }
    rate_ = rate;
    active_ = true;
    sampleTime_ = 0;
    return true;
  }

  void deactivate() override {
    if (active_) AudioUnitUninitialize(unit_);
    active_ = false;
  }

  void reset() override {
    if (active_) AudioUnitReset(unit_, kAudioUnitScope_Global, 0);
  }

  void process(const float* const* in, float* const* out, uint32_t frames) override {
    if (!active_) {
      std::memcpy(out[0], in[0], frames * sizeof(float));
      std::memcpy(out[1], in[1], frames * sizeof(float));
      return;
    }
    input_[0] = in[0];
    input_[1] = in[1];
    struct {
      UInt32 count;
      AudioBuffer buffers[2];
    } list {2, {{1, frames * UInt32(sizeof(float)), out[0]}, {1, frames * UInt32(sizeof(float)), out[1]}}};
    AudioTimeStamp ts {};
    ts.mSampleTime = sampleTime_;
    ts.mFlags = kAudioTimeStampSampleTimeValid;
    AudioUnitRenderActionFlags flags = 0;
    if (AudioUnitRender(unit_, &flags, &ts, 0, frames, reinterpret_cast<AudioBufferList*>(&list)) != noErr) {
      // A failed slice passes the audio on rather than leaving a hole.
      std::memcpy(out[0], in[0], frames * sizeof(float));
      std::memcpy(out[1], in[1], frames * sizeof(float));
    } else {
      // An AU may hand back its own buffers instead of filling ours.
      for (int c = 0; c < 2; ++c) {
        if (list.buffers[c].mData != out[c]) std::memcpy(out[c], list.buffers[c].mData, frames * sizeof(float));
      }
    }
    sampleTime_ += frames;
  }

  uint32_t latency() override {
    Float64 secs = 0;
    UInt32 size = sizeof(secs);
    if (AudioUnitGetProperty(unit_, kAudioUnitProperty_Latency, kAudioUnitScope_Global, 0, &secs, &size) != noErr) {
      return 0;
    }
    return uint32_t(std::max(0.0, std::round(secs * rate_)));
  }

  std::vector<FxParam> params() override {
    std::vector<FxParam> out;
    for (AudioUnitParameterID id : paramIds()) {
      AudioUnitParameterInfo info {};
      if (!paramInfo(id, info)) continue;
      FxParam p;
      p.id = std::to_string(id);
      p.name = info.cfNameString ? fromCF(info.cfNameString) : std::string(info.name);
      if (info.cfNameString && (info.flags & kAudioUnitParameterFlag_CFNameRelease)) CFRelease(info.cfNameString);
      if (info.flags & kAudioUnitParameterFlag_HasClump) p.module = clumpName(id, info.clumpID);
      p.min = info.minValue;
      p.max = info.maxValue;
      p.def = info.defaultValue;
      AudioUnitParameterValue v = info.defaultValue;
      AudioUnitGetParameter(unit_, id, kAudioUnitScope_Global, 0, &v);
      p.value = v;
      p.readOnly = !(info.flags & kAudioUnitParameterFlag_IsWritable);
      p.stepped = info.unit == kAudioUnitParameterUnit_Indexed || info.unit == kAudioUnitParameterUnit_Boolean;
      p.options = options(id, info);
      p.text = text(id, info, v, p.options);
      out.push_back(std::move(p));
    }
    return out;
  }

  bool setParam(const std::string& id, double value) override {
    AudioUnitParameterID pid = 0;
    if (!toId(id, pid)) return false;
    return AudioUnitSetParameter(unit_, pid, kAudioUnitScope_Global, 0, AudioUnitParameterValue(value), 0) == noErr;
  }

  bool parse(const std::string& id, const std::string& text, double& value) override {
    AudioUnitParameterID pid = 0;
    AudioUnitParameterInfo info {};
    if (!toId(id, pid) || !paramInfo(pid, info)) return false;
    for (const auto& [v, t] : options(pid, info)) {
      if (t == text) {
        value = v;
        return true;
      }
    }
    if (info.flags & kAudioUnitParameterFlag_ValuesHaveStrings) {
      CFStringRef s = CFStringCreateWithCString(nullptr, text.c_str(), kCFStringEncodingUTF8);
      AudioUnitParameterValueFromString req {pid, s, 0};
      UInt32 size = sizeof(req);
      const bool ok =
          AudioUnitGetProperty(unit_, kAudioUnitProperty_ParameterValueFromString, kAudioUnitScope_Global, 0, &req, &size) == noErr;
      CFRelease(s);
      if (ok) {
        value = req.outValue;
        return true;
      }
    }
    char* end = nullptr;
    value = std::strtod(text.c_str(), &end);
    // "1.2 kHz" for a parameter in Hz.
    if (end && *end && info.unit == kAudioUnitParameterUnit_Hertz && std::strstr(end, "k")) value *= 1000;
    // "2 ms" for a parameter in seconds.
    if (end && *end && info.unit == kAudioUnitParameterUnit_Seconds && std::strstr(end, "ms")) value /= 1000;
    return end && end != text.c_str();
  }

  bool saveState(std::vector<uint8_t>& out) override {
    out.clear();
    CFPropertyListRef plist = nullptr;
    UInt32 size = sizeof(plist);
    if (AudioUnitGetProperty(unit_, kAudioUnitProperty_ClassInfo, kAudioUnitScope_Global, 0, &plist, &size) != noErr ||
        !plist) {
      return false;
    }
    CFDataRef data = CFPropertyListCreateData(nullptr, plist, kCFPropertyListBinaryFormat_v1_0, 0, nullptr);
    CFRelease(plist);
    if (!data) return false;
    const UInt8* bytes = CFDataGetBytePtr(data);
    out.assign(bytes, bytes + CFDataGetLength(data));
    CFRelease(data);
    return true;
  }

  bool loadState(const std::vector<uint8_t>& in) override {
    CFDataRef data = CFDataCreate(nullptr, in.data(), CFIndex(in.size()));
    CFPropertyListRef plist = CFPropertyListCreateWithData(nullptr, data, kCFPropertyListImmutable, nullptr, nullptr);
    CFRelease(data);
    if (!plist) return false;
    const bool ok =
        AudioUnitSetProperty(unit_, kAudioUnitProperty_ClassInfo, kAudioUnitScope_Global, 0, &plist, sizeof(plist)) == noErr;
    CFRelease(plist);
    return ok;
  }

private:
  static OSStatus pullInput(void* self, AudioUnitRenderActionFlags*, const AudioTimeStamp*, UInt32, UInt32 frames,
                            AudioBufferList* io) {
    auto* me = static_cast<AuPlugin*>(self);
    for (UInt32 c = 0; c < io->mNumberBuffers && c < 2; ++c) {
      std::memcpy(io->mBuffers[c].mData, me->input_[c], frames * sizeof(float));
    }
    return noErr;
  }

  static bool toId(const std::string& id, AudioUnitParameterID& out) {
    char* end = nullptr;
    const unsigned long v = std::strtoul(id.c_str(), &end, 10);
    if (id.empty() || !end || *end) return false;
    out = AudioUnitParameterID(v);
    return true;
  }

  std::vector<AudioUnitParameterID> paramIds() const {
    UInt32 size = 0;
    if (AudioUnitGetPropertyInfo(unit_, kAudioUnitProperty_ParameterList, kAudioUnitScope_Global, 0, &size, nullptr) != noErr) {
      return {};
    }
    std::vector<AudioUnitParameterID> ids(size / sizeof(AudioUnitParameterID));
    if (!ids.empty()) AudioUnitGetProperty(unit_, kAudioUnitProperty_ParameterList, kAudioUnitScope_Global, 0, ids.data(), &size);
    return ids;
  }

  bool paramInfo(AudioUnitParameterID id, AudioUnitParameterInfo& info) const {
    UInt32 size = sizeof(info);
    return AudioUnitGetProperty(unit_, kAudioUnitProperty_ParameterInfo, kAudioUnitScope_Global, id, &info, &size) == noErr;
  }

  std::string clumpName(AudioUnitParameterID id, UInt32 clump) const {
    AudioUnitParameterNameInfo req {clump, kAudioUnitParameterName_Full, nullptr};
    UInt32 size = sizeof(req);
    if (AudioUnitGetProperty(unit_, kAudioUnitProperty_ParameterClumpName, kAudioUnitScope_Global, id, &req, &size) != noErr) {
      return {};
    }
    std::string name = fromCF(req.outName);
    if (req.outName) CFRelease(req.outName);
    return name;
  }

  /** Indexed values with the plugin's names; a switch as Off / On. */
  std::vector<std::pair<double, std::string>> options(AudioUnitParameterID id, const AudioUnitParameterInfo& info) const {
    std::vector<std::pair<double, std::string>> out;
    if (info.unit == kAudioUnitParameterUnit_Boolean) return {{0.0, "Off"}, {1.0, "On"}};
    if (info.unit != kAudioUnitParameterUnit_Indexed) return out;
    CFArrayRef names = nullptr;
    UInt32 size = sizeof(names);
    if (AudioUnitGetProperty(unit_, kAudioUnitProperty_ParameterValueStrings, kAudioUnitScope_Global, id, &names, &size) ==
            noErr &&
        names) {
      for (CFIndex i = 0; i < CFArrayGetCount(names); ++i) {
        out.emplace_back(info.minValue + double(i), fromCF(static_cast<CFStringRef>(CFArrayGetValueAtIndex(names, i))));
      }
      CFRelease(names);
    } else if (info.maxValue - info.minValue <= kMaxOptions) {
      for (double v = info.minValue; v <= info.maxValue; v += 1) out.emplace_back(v, std::to_string(int(v)));
    }
    return out;
  }

  std::string text(AudioUnitParameterID id, const AudioUnitParameterInfo& info, AudioUnitParameterValue v,
                   const std::vector<std::pair<double, std::string>>& opts) const {
    for (const auto& [value, label] : opts) {
      if (std::fabs(value - v) < 1e-4) return label;
    }
    if (info.flags & kAudioUnitParameterFlag_ValuesHaveStrings) {
      AudioUnitParameterStringFromValue req {id, &v, nullptr};
      UInt32 size = sizeof(req);
      if (AudioUnitGetProperty(unit_, kAudioUnitProperty_ParameterStringFromValue, kAudioUnitScope_Global, 0, &req, &size) ==
              noErr &&
          req.outString) {
        std::string s = fromCF(req.outString);
        CFRelease(req.outString);
        if (!s.empty()) return s;
      }
    }
    double shown = v;
    std::string unit = unitSymbol(info.unit);
    // An attack of 0.002 s reads as "2.0 ms", not "0.00 s".
    if (info.unit == kAudioUnitParameterUnit_Seconds && std::fabs(shown) < 1) {
      shown *= 1000;
      unit = "ms";
    }
    if (std::fabs(shown) < 0.005) shown = 0;  // not "-0.00 dB"
    char buf[64];
    std::snprintf(buf, sizeof(buf), std::fabs(shown) >= 100 ? "%.0f" : std::fabs(shown) >= 10 ? "%.1f" : "%.2f", shown);
    std::string s = buf;
    if (info.unit == kAudioUnitParameterUnit_CustomUnit && info.unitName) unit = fromCF(info.unitName);
    if (!unit.empty()) s += " " + unit;
    return s;
  }

  AudioComponentInstance unit_;
  const float* input_[2] = {nullptr, nullptr};
  double rate_ = 48000;
  Float64 sampleTime_ = 0;
  bool active_ = false;
};

AudioComponent findComponent(const std::string& id) {
  AudioComponentDescription d {};
  if (!parseId(id, d)) return nullptr;
  return AudioComponentFindNext(nullptr, &d);
}

} // namespace

std::vector<FxDescriptor> auList() {
  std::vector<FxDescriptor> out;
  for (OSType type : kTypes) {
    AudioComponentDescription d {type, 0, 0, 0, 0};
    for (AudioComponent comp = AudioComponentFindNext(nullptr, &d); comp; comp = AudioComponentFindNext(comp, &d)) {
      FxDescriptor desc = describeComponent(comp);
      // Stereo is known only once an instance takes it: the host describes each one apart.
      desc.needsDescribe = true;
      out.push_back(std::move(desc));
    }
  }
  return out;
}

std::vector<FxDescriptor> auDescribe(const std::string& id, std::string& error) {
  AudioComponent comp = findComponent(id);
  if (!comp) {
    error = "No Audio Unit " + id;
    return {};
  }
  FxDescriptor desc = describeComponent(comp);
  if (AudioComponentInstance unit = instantiate(comp, error)) {
    desc.stereo = configure(unit, 48000, 4096);
    AudioUnitUninitialize(unit);
    AudioComponentInstanceDispose(unit);
  }
  return {desc};
}

std::unique_ptr<FxPlugin> auLoad(const std::string& id, AudioThread&, std::string& error) {
  AudioComponent comp = findComponent(id);
  if (!comp) {
    error = "Audio Unit not installed: " + id;
    return nullptr;
  }
  AudioComponentInstance unit = instantiate(comp, error);
  if (!unit) return nullptr;
  return std::make_unique<AuPlugin>(unit);
}
