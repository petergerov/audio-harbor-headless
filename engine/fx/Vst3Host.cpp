// VST3 (macOS, Linux): the plugin's component and controller, connected; stereo main buses;
// parameters as the controller names and shows them.
#include "FxPlugin.h"

#include "pluginterfaces/base/funknown.h"
#include "pluginterfaces/base/ipluginbase.h"
#include "pluginterfaces/base/smartpointer.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivstcomponent.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "pluginterfaces/vst/ivstmessage.h"
#include "pluginterfaces/vst/ivstprocesscontext.h"
#include "pluginterfaces/vst/ivstunits.h"
#include "pluginterfaces/vst/vstspeaker.h"
#include "public.sdk/source/common/memorystream.h"
#include "public.sdk/source/vst/hosting/hostclasses.h"
#include "public.sdk/source/vst/hosting/parameterchanges.h"
#include "public.sdk/source/vst/hosting/processdata.h"
#include "public.sdk/source/vst/utility/stringconvert.h"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <list>
#include <map>
#include <mutex>
#include <optional>

#if defined(__APPLE__)
#include <CoreFoundation/CoreFoundation.h>
#else
#include <dlfcn.h>
#endif

using namespace Steinberg;
using namespace Steinberg::Vst;
namespace fs = std::filesystem;

namespace {

std::string utf8(const TChar* s) {
  return StringConvert::convert(s);
}

/** A loaded .vst3 bundle, kept for the life of harbor-fx (unloading plugins is where they crash). */
struct Vst3Module {
  IPluginFactory* factory = nullptr;
#if defined(__APPLE__)
  CFBundleRef bundle = nullptr;
#else
  void* handle = nullptr;
#endif
};

std::mutex g_modulesMutex;
std::list<std::pair<std::string, Vst3Module>> g_modules;

using GetFactory = IPluginFactory* (*)();

#if defined(__APPLE__)
std::string describeError(CFErrorRef error) {
  CFStringRef text = CFErrorCopyDescription(error);
  if (!text) return {};
  char buf[512] = {};
  CFStringGetCString(text, buf, sizeof(buf), kCFStringEncodingUTF8);
  CFRelease(text);
  return buf;
}
#else
/** Linux: Contents/<arch>-linux/<name>.so inside the bundle. */
std::string linuxBinary(const std::string& bundle) {
#if defined(__aarch64__)
  const char* arch = "aarch64-linux";
#else
  const char* arch = "x86_64-linux";
#endif
  const fs::path p(bundle);
  return (p / "Contents" / arch / (p.stem().string() + ".so")).string();
}
#endif

const Vst3Module* openModule(const std::string& path, std::string& error) {
  std::lock_guard lock(g_modulesMutex);
  for (auto& m : g_modules) {
    if (m.first == path) return &m.second;
  }
  Vst3Module mod;
  GetFactory getFactory = nullptr;
#if defined(__APPLE__)
  CFURLRef url = CFURLCreateFromFileSystemRepresentation(
      kCFAllocatorDefault, reinterpret_cast<const UInt8*>(path.c_str()), CFIndex(path.size()), true);
  mod.bundle = url ? CFBundleCreate(kCFAllocatorDefault, url) : nullptr;
  if (url) CFRelease(url);
  CFErrorRef loadError = nullptr;
  if (!mod.bundle || !CFBundleLoadExecutableAndReturnError(mod.bundle, &loadError)) {
    // Its own words, e.g. that it has no version for this Mac's processor.
    error = "Cannot load " + path + (loadError ? ": " + describeError(loadError) : "");
    if (loadError) CFRelease(loadError);
    return nullptr;
  }
  using BundleEntry = bool (*)(CFBundleRef);
  if (auto entry = reinterpret_cast<BundleEntry>(CFBundleGetFunctionPointerForName(mod.bundle, CFSTR("bundleEntry")))) {
    if (!entry(mod.bundle)) {
      error = "The plugin did not start: " + path;
      return nullptr;
    }
  }
  getFactory = reinterpret_cast<GetFactory>(CFBundleGetFunctionPointerForName(mod.bundle, CFSTR("GetPluginFactory")));
#else
  const std::string bin = linuxBinary(path);
  mod.handle = dlopen(bin.c_str(), RTLD_LOCAL | RTLD_NOW);
  if (!mod.handle) {
    const char* why = dlerror();
    error = "Cannot load " + bin + (why ? std::string(": ") + why : "");
    return nullptr;
  }
  using ModuleEntry = bool (*)(void*);
  if (auto entry = reinterpret_cast<ModuleEntry>(dlsym(mod.handle, "ModuleEntry"))) {
    if (!entry(mod.handle)) {
      error = "The plugin did not start: " + path;
      return nullptr;
    }
  }
  getFactory = reinterpret_cast<GetFactory>(dlsym(mod.handle, "GetPluginFactory"));
#endif
  mod.factory = getFactory ? getFactory() : nullptr;
  if (!mod.factory) {
    error = "No VST3 factory in " + path;
    return nullptr;
  }
  g_modules.emplace_back(path, mod);
  return &g_modules.back().second;
}

/** One host context for every plugin (name, message and attribute objects). */
FUnknown* hostContext() {
  static IPtr<HostApplication> host = owned(new HostApplication());
  return host;
}

/** "{CID as 32 hex digits}" — the class id as the rack stores it. */
std::string cidString(const TUID cid) {
  char buf[40];
  for (int i = 0; i < 16; ++i) std::snprintf(buf + 2 * i, 3, "%02X", static_cast<unsigned char>(cid[i]));
  return buf;
}

bool cidFrom(const std::string& s, TUID cid) {
  if (s.size() != 32) return false;
  for (int i = 0; i < 16; ++i) {
    unsigned v = 0;
    if (std::sscanf(s.c_str() + 2 * i, "%2X", &v) != 1) return false;
    cid[i] = static_cast<char>(v);
  }
  return true;
}

/** Receives what the controller says to the host: edits (from no UI here) and restarts. */
class ComponentHandler final : public IComponentHandler {
public:
  bool restart = false;
  tresult PLUGIN_API beginEdit(ParamID) override { return kResultOk; }
  tresult PLUGIN_API performEdit(ParamID, ParamValue) override { return kResultOk; }
  tresult PLUGIN_API endEdit(ParamID) override { return kResultOk; }
  tresult PLUGIN_API restartComponent(int32 flags) override {
    if (flags & (kLatencyChanged | kIoChanged | kReloadComponent)) restart = true;
    return kResultOk;
  }
  tresult PLUGIN_API queryInterface(const TUID iid, void** obj) override {
    if (FUnknownPrivate::iidEqual(iid, IComponentHandler::iid) || FUnknownPrivate::iidEqual(iid, FUnknown::iid)) {
      *obj = this;
      return kResultOk;
    }
    *obj = nullptr;
    return kNoInterface;
  }
  uint32 PLUGIN_API addRef() override { return 1; }
  uint32 PLUGIN_API release() override { return 1; }
};

class Vst3Plugin final : public FxPlugin {
public:
  ~Vst3Plugin() override {
    deactivate();
    if (componentCP_ && controllerCP_) {
      componentCP_->disconnect(controllerCP_);
      controllerCP_->disconnect(componentCP_);
    }
    if (controller_) {
      controller_->setComponentHandler(nullptr);
      if (!singleComponent_) controller_->terminate();
    }
    if (component_) component_->terminate();
  }

  bool create(IPluginFactory* factory, const TUID cid, std::string& error) {
    IComponent* component = nullptr;
    if (factory->createInstance(cid, IComponent::iid, reinterpret_cast<void**>(&component)) != kResultOk || !component) {
      error = "The plugin could not be created";
      return false;
    }
    component_ = owned(component);
    if (component_->initialize(hostContext()) != kResultOk) {
      error = "The plugin did not start";
      return false;
    }
    processor_ = FUnknownPtr<IAudioProcessor>(component_);
    if (!processor_) {
      error = "Not an audio effect";
      return false;
    }
    // One object for both, or a controller of its own.
    controller_ = FUnknownPtr<IEditController>(component_);
    singleComponent_ = static_cast<bool>(controller_);
    if (!controller_) {
      TUID ccid;
      IEditController* controller = nullptr;
      if (component_->getControllerClassId(ccid) == kResultOk &&
          factory->createInstance(ccid, IEditController::iid, reinterpret_cast<void**>(&controller)) == kResultOk &&
          controller) {
        controller_ = owned(controller);
        if (controller_->initialize(hostContext()) != kResultOk) controller_ = nullptr;
      }
    }
    if (controller_) {
      controller_->setComponentHandler(&handler_);
      componentCP_ = FUnknownPtr<IConnectionPoint>(component_);
      controllerCP_ = FUnknownPtr<IConnectionPoint>(controller_);
      if (componentCP_ && controllerCP_ && !singleComponent_) {
        componentCP_->connect(controllerCP_);
        controllerCP_->connect(componentCP_);
      }
      syncController();
      units_ = FUnknownPtr<IUnitInfo>(controller_);
    }
    return true;
  }

  /** Stereo main in and out, other buses off. False when the plugin will not. */
  bool stereo() {
    const int32 ins = component_->getBusCount(kAudio, kInput);
    const int32 outs = component_->getBusCount(kAudio, kOutput);
    if (ins < 1 || outs < 1) return false;
    std::vector<SpeakerArrangement> inArr(size_t(ins), SpeakerArr::kStereo), outArr(size_t(outs), SpeakerArr::kStereo);
    for (int32 i = 1; i < ins; ++i) processor_->getBusArrangement(kInput, i, inArr[size_t(i)]);
    for (int32 i = 1; i < outs; ++i) processor_->getBusArrangement(kOutput, i, outArr[size_t(i)]);
    processor_->setBusArrangements(inArr.data(), ins, outArr.data(), outs);
    SpeakerArrangement in = 0, out = 0;
    processor_->getBusArrangement(kInput, 0, in);
    processor_->getBusArrangement(kOutput, 0, out);
    if (in != SpeakerArr::kStereo || out != SpeakerArr::kStereo) return false;
    for (int32 i = 0; i < ins; ++i) component_->activateBus(kAudio, kInput, i, i == 0);
    for (int32 i = 0; i < outs; ++i) component_->activateBus(kAudio, kOutput, i, i == 0);
    return processor_->canProcessSampleSize(kSample32) == kResultTrue;
  }

  bool activate(double rate, uint32_t maxBlock, std::string& error) override {
    deactivate();
    if (!stereo()) {
      error = "Not a stereo effect (2 in, 2 out)";
      return false;
    }
    ProcessSetup setup {kRealtime, kSample32, int32(maxBlock), rate};
    if (processor_->setupProcessing(setup) != kResultOk) {
      error = "The plugin refused " + std::to_string(int(rate)) + " Hz";
      return false;
    }
    data_.prepare(*component_, int32(maxBlock), kSample32);
    inChanges_.setMaxParameters(paramCount());
    outChanges_.setMaxParameters(paramCount());
    data_.inputParameterChanges = &inChanges_;
    data_.outputParameterChanges = &outChanges_;
    context_ = ProcessContext {};
    context_.sampleRate = rate;
    data_.processContext = &context_;
    if (component_->setActive(true) != kResultOk) {
      error = "The plugin did not activate";
      return false;
    }
    active_ = true;
    audio_->run([&] { processor_->setProcessing(true); });
    handler_.restart = false;
    return true;
  }

  void deactivate() override {
    if (!active_) return;
    audio_->run([&] { processor_->setProcessing(false); });
    component_->setActive(false);
    data_.unprepare();
    active_ = false;
  }

  void reset() override {
    // VST3 has no reset: processing off and on clears the plugin's buffers.
    if (!active_) return;
    processor_->setProcessing(false);
    processor_->setProcessing(true);
  }

  void process(const float* const* in, float* const* out, uint32_t frames) override {
    if (!active_ || data_.numInputs < 1 || data_.numOutputs < 1) {
      std::memcpy(out[0], in[0], frames * sizeof(float));
      std::memcpy(out[1], in[1], frames * sizeof(float));
      return;
    }
    {
      std::lock_guard lock(mutex_);
      for (const auto& [id, value] : pending_) {
        int32 index = 0;
        if (IParamValueQueue* q = inChanges_.addParameterData(id, index)) {
          int32 point = 0;
          q->addPoint(0, value, point);
        }
      }
      pending_.clear();
    }
    for (int c = 0; c < 2; ++c) std::memcpy(data_.inputs[0].channelBuffers32[c], in[c], frames * sizeof(float));
    data_.numSamples = int32(frames);
    context_.projectTimeSamples = TSamples(sampleTime_);
    processor_->process(data_);
    for (int c = 0; c < 2; ++c) std::memcpy(out[c], data_.outputs[0].channelBuffers32[c], frames * sizeof(float));
    sampleTime_ += frames;
    inChanges_.clearQueue();
    collectOutputs();
  }

  uint32_t latency() override {
    return active_ ? processor_->getLatencySamples() : 0;
  }

  std::vector<FxParam> params() override {
    std::vector<FxParam> out;
    if (!controller_) return out;
    applyOutputs();
    const std::map<UnitID, std::string> units = unitNames();
    for (int32 i = 0, n = controller_->getParameterCount(); i < n; ++i) {
      ParameterInfo info {};
      if (controller_->getParameterInfo(i, info) != kResultOk) continue;
      if (info.flags & ParameterInfo::kIsHidden) continue;
      FxParam p;
      p.id = std::to_string(info.id);
      p.name = utf8(info.title);
      if (auto u = units.find(info.unitId); u != units.end() && info.unitId != kRootUnitId) p.module = u->second;
      const ParamValue norm = pendingValue(info.id).value_or(controller_->getParamNormalized(info.id));
      p.stepped = info.stepCount > 0;
      p.min = 0;
      p.max = p.stepped ? info.stepCount : 1;
      p.def = p.stepped ? std::round(info.defaultNormalizedValue * info.stepCount) : info.defaultNormalizedValue;
      p.value = p.stepped ? std::round(norm * info.stepCount) : norm;
      p.readOnly = info.flags & ParameterInfo::kIsReadOnly;
      p.isBypass = info.flags & ParameterInfo::kIsBypass;
      p.text = text(info.id, norm, utf8(info.units));
      if (p.stepped && info.stepCount <= kMaxOptions) {
        for (int32 s = 0; s <= info.stepCount; ++s) {
          p.options.emplace_back(double(s), text(info.id, double(s) / info.stepCount, ""));
        }
      }
      out.push_back(std::move(p));
    }
    return out;
  }

  bool setParam(const std::string& id, double value) override {
    ParamID pid = 0;
    int32 steps = 0;
    if (!controller_ || !toId(id, pid) || !stepCount(pid, steps)) return false;
    const ParamValue norm = std::clamp(steps > 0 ? value / steps : value, 0.0, 1.0);
    controller_->setParamNormalized(pid, norm);
    std::lock_guard lock(mutex_);
    pending_[pid] = norm;
    return true;
  }

  bool parse(const std::string& id, const std::string& textIn, double& value) override {
    ParamID pid = 0;
    int32 steps = 0;
    if (!controller_ || !toId(id, pid) || !stepCount(pid, steps)) return false;
    std::u16string wide = StringConvert::convert(textIn);
    ParamValue norm = 0;
    if (controller_->getParamValueByString(pid, reinterpret_cast<TChar*>(wide.data()), norm) != kResultOk) {
      // Plugins that do not parse their own text: the number alone, as plain value.
      char* end = nullptr;
      const double plain = std::strtod(textIn.c_str(), &end);
      if (!end || end == textIn.c_str()) return false;
      norm = controller_->plainParamToNormalized(pid, plain);
    }
    value = steps > 0 ? std::round(norm * steps) : norm;
    return true;
  }

  bool saveState(std::vector<uint8_t>& out) override {
    out.clear();
    MemoryStream comp, ctrl;
    if (component_->getState(&comp) != kResultOk) return false;
    if (controller_) controller_->getState(&ctrl);
    // "HV3" + component size + component state + controller state.
    const uint32_t size = uint32_t(comp.getSize());
    out = {'H', 'V', '3', 0};
    for (int i = 0; i < 4; ++i) out.push_back(uint8_t(size >> (8 * i)));
    out.insert(out.end(), comp.getData(), comp.getData() + comp.getSize());
    out.insert(out.end(), ctrl.getData(), ctrl.getData() + ctrl.getSize());
    return true;
  }

  bool loadState(const std::vector<uint8_t>& in) override {
    if (in.size() < 8 || std::memcmp(in.data(), "HV3", 4) != 0) return false;
    const uint32_t size = uint32_t(in[4]) | uint32_t(in[5]) << 8 | uint32_t(in[6]) << 16 | uint32_t(in[7]) << 24;
    if (8 + size_t(size) > in.size()) return false;
    std::vector<uint8_t> compBytes(in.begin() + 8, in.begin() + 8 + size);
    std::vector<uint8_t> ctrlBytes(in.begin() + 8 + size, in.end());
    {
      // Values set before but not yet processed would undo the state on the next block.
      std::lock_guard lock(mutex_);
      pending_.clear();
      outputs_.clear();
    }
    MemoryStream comp(compBytes.data(), TSize(compBytes.size()));
    if (component_->setState(&comp) != kResultOk) return false;
    if (controller_) {
      MemoryStream again(compBytes.data(), TSize(compBytes.size()));
      controller_->setComponentState(&again);
      if (!ctrlBytes.empty()) {
        MemoryStream ctrl(ctrlBytes.data(), TSize(ctrlBytes.size()));
        controller_->setState(&ctrl);
      }
    }
    return true;
  }

  bool wantsRestart() override {
    const bool r = handler_.restart;
    handler_.restart = false;
    return r;
  }

  void setAudioThread(AudioThread& audio) { audio_ = &audio; }

private:
  /** The controller starts from the component's state, as a DAW does on load. */
  void syncController() {
    MemoryStream s;
    if (component_->getState(&s) == kResultOk) {
      s.seek(0, IBStream::kIBSeekSet, nullptr);
      controller_->setComponentState(&s);
    }
  }

  static bool toId(const std::string& id, ParamID& out) {
    char* end = nullptr;
    const unsigned long v = std::strtoul(id.c_str(), &end, 10);
    if (id.empty() || !end || *end) return false;
    out = ParamID(v);
    return true;
  }

  int32 paramCount() const { return controller_ ? controller_->getParameterCount() : 0; }

  bool stepCount(ParamID pid, int32& steps) const {
    for (int32 i = 0, n = paramCount(); i < n; ++i) {
      ParameterInfo info {};
      if (controller_->getParameterInfo(i, info) == kResultOk && info.id == pid) {
        steps = info.stepCount;
        return true;
      }
    }
    return false;
  }

  std::optional<ParamValue> pendingValue(ParamID pid) {
    std::lock_guard lock(mutex_);
    auto it = pending_.find(pid);
    return it == pending_.end() ? std::nullopt : std::optional<ParamValue>(it->second);
  }

  std::string text(ParamID pid, ParamValue norm, const std::string& units) const {
    String128 s {};
    if (controller_->getParamStringByValue(pid, norm, s) == kResultOk && s[0]) {
      std::string out = utf8(s);
      if (!units.empty() && out.find(units) == std::string::npos) out += " " + units;
      return out;
    }
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%.3g", norm);
    return buf;
  }

  std::map<UnitID, std::string> unitNames() const {
    std::map<UnitID, std::string> out;
    if (!units_) return out;
    for (int32 i = 0, n = units_->getUnitCount(); i < n; ++i) {
      UnitInfo info {};
      if (units_->getUnitInfo(i, info) == kResultOk) out[info.id] = utf8(info.name);
    }
    return out;
  }

  /** The processor's own changes (meters, linked values), handed to the controller later. */
  void collectOutputs() {
    std::lock_guard lock(mutex_);
    for (int32 i = 0, n = outChanges_.getParameterCount(); i < n; ++i) {
      IParamValueQueue* q = outChanges_.getParameterData(i);
      if (!q || q->getPointCount() < 1) continue;
      int32 offset = 0;
      ParamValue v = 0;
      if (q->getPoint(q->getPointCount() - 1, offset, v) == kResultOk) outputs_[q->getParameterId()] = v;
    }
    outChanges_.clearQueue();
  }

  /** On the main thread, as the controller wants. */
  void applyOutputs() {
    std::map<ParamID, ParamValue> values;
    {
      std::lock_guard lock(mutex_);
      values.swap(outputs_);
    }
    for (const auto& [id, v] : values) controller_->setParamNormalized(id, v);
  }

  IPtr<IComponent> component_;
  FUnknownPtr<IAudioProcessor> processor_ {nullptr};
  IPtr<IEditController> controller_;
  FUnknownPtr<IConnectionPoint> componentCP_ {nullptr};
  FUnknownPtr<IConnectionPoint> controllerCP_ {nullptr};
  FUnknownPtr<IUnitInfo> units_ {nullptr};
  bool singleComponent_ = false;
  ComponentHandler handler_;
  HostProcessData data_;
  ParameterChanges inChanges_;
  ParameterChanges outChanges_;
  ProcessContext context_ {};
  AudioThread* audio_ = nullptr;
  std::mutex mutex_;
  std::map<ParamID, ParamValue> pending_;
  std::map<ParamID, ParamValue> outputs_;
  uint64_t sampleTime_ = 0;
  bool active_ = false;
};

std::vector<fs::path> searchPaths() {
  std::vector<fs::path> dirs;
  if (const char* env = std::getenv("VST3_PATH")) {
    std::string all = env;
    for (size_t start = 0; start <= all.size();) {
      const size_t end = all.find(':', start);
      const std::string part = all.substr(start, end == std::string::npos ? std::string::npos : end - start);
      if (!part.empty()) dirs.emplace_back(part);
      if (end == std::string::npos) break;
      start = end + 1;
    }
  }
  const char* home = std::getenv("HOME");
#if defined(__APPLE__)
  if (home) dirs.push_back(fs::path(home) / "Library/Audio/Plug-Ins/VST3");
  dirs.emplace_back("/Library/Audio/Plug-Ins/VST3");
#else
  if (home) dirs.push_back(fs::path(home) / ".vst3");
  dirs.emplace_back("/usr/lib/vst3");
  dirs.emplace_back("/usr/local/lib/vst3");
#endif
  return dirs;
}

bool isEffect(const PClassInfo2& info) {
  const std::string sub = info.subCategories;
  return std::strcmp(info.category, kVstAudioEffectClass) == 0 && sub.find("Instrument") == std::string::npos;
}

} // namespace

std::vector<FxDescriptor> vst3List() {
  std::vector<FxDescriptor> out;
  for (const auto& dir : searchPaths()) {
    std::error_code ec;
    if (!fs::is_directory(dir, ec)) continue;
    fs::recursive_directory_iterator it(dir, fs::directory_options::skip_permission_denied, ec), end;
    for (; it != end; it.increment(ec)) {
      if (ec) break;
      if (it->path().extension() != ".vst3") continue;
      FxDescriptor d;
      d.format = "vst3";
      d.path = it->path().string();
      out.push_back(std::move(d));
      it.disable_recursion_pending();
    }
  }
  return out;
}

std::vector<FxDescriptor> vst3Describe(const std::string& path, std::string& error) {
  std::vector<FxDescriptor> out;
  const Vst3Module* mod = openModule(path, error);
  if (!mod) return out;
  FUnknownPtr<IPluginFactory2> factory2(mod->factory);
  PFactoryInfo finfo {};
  mod->factory->getFactoryInfo(&finfo);
  AudioThread audio;
  for (int32 i = 0, n = mod->factory->countClasses(); i < n; ++i) {
    PClassInfo2 info {};
    if (factory2) {
      if (factory2->getClassInfo2(i, &info) != kResultOk) continue;
    } else {
      PClassInfo basic {};
      if (mod->factory->getClassInfo(i, &basic) != kResultOk) continue;
      std::memcpy(info.cid, basic.cid, sizeof(TUID));
      std::strncpy(info.category, basic.category, sizeof(info.category));
      std::strncpy(info.name, basic.name, sizeof(info.name));
    }
    if (std::strcmp(info.category, kVstAudioEffectClass) != 0) continue;
    FxDescriptor d;
    d.format = "vst3";
    d.path = path;
    d.id = cidString(info.cid);
    d.name = info.name;
    d.vendor = info.vendor[0] ? info.vendor : finfo.vendor;
    d.version = info.version;
    std::string sub = info.subCategories;
    for (size_t start = 0; !sub.empty() && start <= sub.size();) {
      const size_t bar = sub.find('|', start);
      d.features.push_back(sub.substr(start, bar == std::string::npos ? std::string::npos : bar - start));
      if (bar == std::string::npos) break;
      start = bar + 1;
    }
    if (isEffect(info)) {
      Vst3Plugin probe;
      probe.setAudioThread(audio);
      std::string why;
      d.stereo = probe.create(mod->factory, info.cid, why) && probe.stereo();
    }
    out.push_back(std::move(d));
  }
  return out;
}

std::unique_ptr<FxPlugin> vst3Load(const std::string& path, const std::string& id, AudioThread& audio, std::string& error) {
  const Vst3Module* mod = openModule(path, error);
  if (!mod) return nullptr;
  TUID cid;
  if (!cidFrom(id, cid)) {
    error = "Bad VST3 class id " + id;
    return nullptr;
  }
  auto plugin = std::make_unique<Vst3Plugin>();
  plugin->setAudioThread(audio);
  if (!plugin->create(mod->factory, cid, error)) return nullptr;
  return plugin;
}
