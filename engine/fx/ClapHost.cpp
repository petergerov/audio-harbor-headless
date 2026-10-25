#include "FxPlugin.h"

#include <clap/clap.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <list>
#include <mutex>

#if defined(_WIN32)
#include <windows.h>
#else
#include <dlfcn.h>
#endif
#if defined(__APPLE__)
#include <CoreFoundation/CoreFoundation.h>
#endif

namespace fs = std::filesystem;

namespace {

/** The binary inside a .clap: a macOS bundle's executable, else the file itself. */
std::string binaryPath(const std::string& path) {
#if defined(__APPLE__)
  if (fs::is_directory(path)) {
    CFURLRef url = CFURLCreateFromFileSystemRepresentation(
        kCFAllocatorDefault, reinterpret_cast<const UInt8*>(path.c_str()), CFIndex(path.size()), true);
    if (!url) return {};
    CFBundleRef bundle = CFBundleCreate(kCFAllocatorDefault, url);
    CFRelease(url);
    if (!bundle) return {};
    std::string out;
    if (CFURLRef exe = CFBundleCopyExecutableURL(bundle)) {
      char buf[4096];
      if (CFURLGetFileSystemRepresentation(exe, true, reinterpret_cast<UInt8*>(buf), sizeof(buf))) out = buf;
      CFRelease(exe);
    }
    CFRelease(bundle);
    return out;
  }
#endif
  return path;
}

/**
 * A loaded .clap file. Kept open for the life of harbor-fx: plugins may leave threads or
 * static state behind, and unloading them is a common source of crashes.
 */
struct ClapLibrary {
  void* handle = nullptr;
  const clap_plugin_entry* entry = nullptr;
  const clap_plugin_factory* factory = nullptr;
};

std::mutex g_libMutex;
// A list: openLibrary hands out pointers into it.
std::list<std::pair<std::string, ClapLibrary>> g_libs;

const ClapLibrary* openLibrary(const std::string& path, std::string& error) {
  std::lock_guard lock(g_libMutex);
  for (auto& lib : g_libs) {
    if (lib.first == path) return &lib.second;
  }
  const std::string bin = binaryPath(path);
  if (bin.empty()) {
    error = "Not a CLAP bundle: " + path;
    return nullptr;
  }
  ClapLibrary lib;
#if defined(_WIN32)
  lib.handle = LoadLibraryA(bin.c_str());
  if (!lib.handle) {
    error = "Cannot load " + bin;
    return nullptr;
  }
  lib.entry = reinterpret_cast<const clap_plugin_entry*>(GetProcAddress(HMODULE(lib.handle), "clap_entry"));
#else
  lib.handle = dlopen(bin.c_str(), RTLD_LOCAL | RTLD_NOW);
  if (!lib.handle) {
    const char* why = dlerror();
    error = "Cannot load " + bin + (why ? std::string(": ") + why : "");
    return nullptr;
  }
  lib.entry = static_cast<const clap_plugin_entry*>(dlsym(lib.handle, "clap_entry"));
#endif
  if (!lib.entry) {
    error = "No clap_entry in " + bin;
    return nullptr;
  }
  if (!clap_version_is_compatible(lib.entry->clap_version)) {
    error = "Unsupported CLAP version in " + path;
    return nullptr;
  }
  if (!lib.entry->init(path.c_str())) {
    error = "CLAP init failed: " + path;
    return nullptr;
  }
  lib.factory = static_cast<const clap_plugin_factory*>(lib.entry->get_factory(CLAP_PLUGIN_FACTORY_ID));
  if (!lib.factory) {
    error = "No plugin factory in " + path;
    return nullptr;
  }
  g_libs.emplace_back(path, lib);
  return &g_libs.back().second;
}

/** A buffer for every audio port of one direction; the main port carries the rack's audio. */
struct PortBuffers {
  std::vector<clap_audio_buffer> buffers;
  std::vector<std::vector<float*>> pointers;
  std::vector<std::vector<float>> storage;
  size_t main = 0;

  void build(const clap_plugin_audio_ports* ports, const clap_plugin* plugin, bool input, uint32_t maxBlock) {
    buffers.clear();
    pointers.clear();
    storage.clear();
    main = 0;
    const uint32_t n = ports ? ports->count(plugin, input) : 1;
    bool foundMain = false;
    for (uint32_t i = 0; i < n; ++i) {
      clap_audio_port_info info {};
      uint32_t channels = 2;
      if (ports && ports->get(plugin, i, input, &info)) {
        channels = info.channel_count;
        if (!foundMain && (info.flags & CLAP_AUDIO_PORT_IS_MAIN)) {
          main = i;
          foundMain = true;
        }
      }
      std::vector<float*> ptrs(channels, nullptr);
      for (uint32_t c = 0; c < channels; ++c) {
        storage.emplace_back(maxBlock, 0.0f);
        ptrs[c] = storage.back().data();
      }
      pointers.push_back(std::move(ptrs));
    }
    // Pointers into `storage` stay valid: it is not touched again until the next build.
    for (auto& ptrs : pointers) {
      clap_audio_buffer b {};
      b.data32 = ptrs.data();
      b.channel_count = uint32_t(ptrs.size());
      buffers.push_back(b);
    }
  }

  /** Main port → the rack's channels; other inputs silent. */
  void bind(float* left, float* right, uint32_t frames, bool input) {
    for (size_t i = 0; i < pointers.size(); ++i) {
      auto& ptrs = pointers[i];
      if (i == main && ptrs.size() == 2) {
        ptrs[0] = left;
        ptrs[1] = right;
      } else if (input) {
        for (float* ch : ptrs) std::memset(ch, 0, frames * sizeof(float));
      }
    }
  }
};

class ClapPlugin;

/** Parameter changes queued for the next process() or flush(). */
struct EventQueue {
  std::vector<clap_event_param_value> events;

  static uint32_t size(const clap_input_events* list) {
    return uint32_t(static_cast<EventQueue*>(list->ctx)->events.size());
  }
  static const clap_event_header_t* get(const clap_input_events* list, uint32_t index) {
    auto* q = static_cast<EventQueue*>(list->ctx);
    return index < q->events.size() ? &q->events[index].header : nullptr;
  }
  clap_input_events input() {
    return clap_input_events {this, &EventQueue::size, &EventQueue::get};
  }
};

class ClapPlugin final : public FxPlugin {
public:
  ClapPlugin(AudioThread& audio) : audio_(audio) {
    host_.clap_version = CLAP_VERSION;
    host_.host_data = this;
    host_.name = "Audio Harbor Headless";
    host_.vendor = "Audio Harbor";
    host_.url = "https://github.com/petergerov/audio-harbor-headless";
    host_.version = "1";
    host_.get_extension = &ClapPlugin::hostExtension;
    host_.request_restart = [](const clap_host* h) { self(h)->restart_ = true; };
    host_.request_process = [](const clap_host*) {};
    host_.request_callback = [](const clap_host* h) { self(h)->callback_ = true; };
  }

  ~ClapPlugin() override {
    deactivate();
    if (plugin_) plugin_->destroy(plugin_);
  }

  bool create(const ClapLibrary& lib, const std::string& id, std::string& error) {
    plugin_ = lib.factory->create_plugin(lib.factory, &host_, id.c_str());
    if (!plugin_) {
      error = "Plugin " + id + " not found";
      return false;
    }
    if (!plugin_->init(plugin_)) {
      error = "Plugin " + id + " failed to start";
      plugin_->destroy(plugin_);
      plugin_ = nullptr;
      return false;
    }
    params_ = static_cast<const clap_plugin_params*>(plugin_->get_extension(plugin_, CLAP_EXT_PARAMS));
    state_ = static_cast<const clap_plugin_state*>(plugin_->get_extension(plugin_, CLAP_EXT_STATE));
    latency_ = static_cast<const clap_plugin_latency*>(plugin_->get_extension(plugin_, CLAP_EXT_LATENCY));
    ports_ = static_cast<const clap_plugin_audio_ports*>(plugin_->get_extension(plugin_, CLAP_EXT_AUDIO_PORTS));
    return true;
  }

  /** Channels of the main input and output port; 0 when the plugin has none. */
  void mainPorts(uint32_t& in, uint32_t& out) const {
    in = out = 0;
    if (!ports_) return;
    auto main = [&](bool input) -> uint32_t {
      const uint32_t n = ports_->count(plugin_, input);
      for (uint32_t i = 0; i < n; ++i) {
        clap_audio_port_info info {};
        if (!ports_->get(plugin_, i, input, &info)) continue;
        if ((info.flags & CLAP_AUDIO_PORT_IS_MAIN) || i == 0) return info.channel_count;
      }
      return 0;
    };
    in = main(true);
    out = main(false);
  }

  bool activate(double rate, uint32_t maxBlock, std::string& error) override {
    deactivate();
    mainPorts(inChannels_, outChannels_);
    if (inChannels_ != 2 || outChannels_ != 2) {
      error = "Not a stereo effect (2 in, 2 out)";
      return false;
    }
    // Plugins read every port they declare (Pro-Q: a sidechain), so each gets a buffer.
    inPorts_.build(ports_, plugin_, true, maxBlock);
    outPorts_.build(ports_, plugin_, false, maxBlock);
    if (!plugin_->activate(plugin_, rate, 1, maxBlock)) {
      error = "Plugin refused " + std::to_string(int(rate)) + " Hz";
      return false;
    }
    active_ = true;
    bool started = false;
    audio_.run([&] { started = plugin_->start_processing(plugin_); });
    processing_ = started;
    if (!started) {
      plugin_->deactivate(plugin_);
      active_ = false;
      error = "Plugin did not start processing";
      return false;
    }
    restart_ = false;
    return true;
  }

  void deactivate() override {
    if (!plugin_ || !active_) return;
    if (processing_) audio_.run([&] { plugin_->stop_processing(plugin_); });
    processing_ = false;
    plugin_->deactivate(plugin_);
    active_ = false;
  }

  void reset() override {
    if (active_) plugin_->reset(plugin_);
  }

  void process(const float* const* in, float* const* out, uint32_t frames) override {
    if (!active_) {
      std::memcpy(out[0], in[0], frames * sizeof(float));
      std::memcpy(out[1], in[1], frames * sizeof(float));
      return;
    }
    inPorts_.bind(const_cast<float*>(in[0]), const_cast<float*>(in[1]), frames, true);
    outPorts_.bind(out[0], out[1], frames, false);

    EventQueue queue;
    {
      std::lock_guard lock(pendingMutex_);
      queue.events.swap(pending_);
    }
    const clap_input_events inEvents = queue.input();
    clap_output_events outEvents {this, &ClapPlugin::pushOut};

    clap_process p {};
    p.steady_time = int64_t(steadyTime_);
    p.frames_count = frames;
    p.audio_inputs = inPorts_.buffers.data();
    p.audio_inputs_count = uint32_t(inPorts_.buffers.size());
    p.audio_outputs = outPorts_.buffers.data();
    p.audio_outputs_count = uint32_t(outPorts_.buffers.size());
    p.in_events = &inEvents;
    p.out_events = &outEvents;
    plugin_->process(plugin_, &p);
    steadyTime_ += frames;
  }

  uint32_t latency() override {
    return active_ && latency_ ? latency_->get(plugin_) : 0;
  }

  std::vector<FxParam> params() override {
    std::vector<FxParam> out;
    if (!params_) return out;
    const uint32_t n = params_->count(plugin_);
    for (uint32_t i = 0; i < n; ++i) {
      clap_param_info info {};
      if (!params_->get_info(plugin_, i, &info)) continue;
      if (info.flags & (CLAP_PARAM_IS_HIDDEN | CLAP_PARAM_IS_READONLY)) continue;
      FxParam p;
      p.id = std::to_string(info.id);
      p.name = info.name;
      p.module = info.module;
      p.min = info.min_value;
      p.max = info.max_value;
      p.def = info.default_value;
      double v = info.default_value;
      params_->get_value(plugin_, info.id, &v);
      p.value = pendingValue(info.id, v);
      p.text = text(info.id, p.value);
      p.stepped = info.flags & CLAP_PARAM_IS_STEPPED;
      p.isBypass = info.flags & CLAP_PARAM_IS_BYPASS;
      if (p.stepped && p.max - p.min <= kMaxOptions) {
        for (double v = std::ceil(p.min); v <= p.max; v += 1) p.options.emplace_back(v, text(info.id, v));
      }
      out.push_back(std::move(p));
    }
    return out;
  }

  bool setParam(const std::string& id, double value) override {
    clap_id pid = 0;
    if (!params_ || !toId(id, pid)) return false;
    clap_event_param_value ev {};
    ev.header.size = sizeof(ev);
    ev.header.space_id = CLAP_CORE_EVENT_SPACE_ID;
    ev.header.type = CLAP_EVENT_PARAM_VALUE;
    ev.param_id = clap_id(pid);
    ev.note_id = -1;
    ev.port_index = -1;
    ev.channel = -1;
    ev.key = -1;
    ev.value = value;
    {
      std::lock_guard lock(pendingMutex_);
      pending_.push_back(ev);
    }
    // Not processing until the next block: hand it over now, so get_value tells the truth.
    flush();
    return true;
  }

  bool parse(const std::string& id, const std::string& text, double& value) override {
    clap_id pid = 0;
    if (!params_ || !toId(id, pid)) return false;
    if (params_->text_to_value && params_->text_to_value(plugin_, pid, text.c_str(), &value)) return true;
    char* end = nullptr;
    value = std::strtod(text.c_str(), &end);
    return end && end != text.c_str();
  }

  bool saveState(std::vector<uint8_t>& out) override {
    out.clear();
    if (!state_) return false;
    flush();
    clap_ostream stream {&out, [](const clap_ostream* s, const void* buf, uint64_t size) -> int64_t {
                           auto* v = static_cast<std::vector<uint8_t>*>(s->ctx);
                           const auto* p = static_cast<const uint8_t*>(buf);
                           v->insert(v->end(), p, p + size);
                           return int64_t(size);
                         }};
    return state_->save(plugin_, &stream);
  }

  bool loadState(const std::vector<uint8_t>& in) override {
    if (!state_) return false;
    struct Reader {
      const std::vector<uint8_t>* data;
      size_t pos;
    } reader {&in, 0};
    clap_istream stream {&reader, [](const clap_istream* s, void* buf, uint64_t size) -> int64_t {
                           auto* r = static_cast<Reader*>(s->ctx);
                           const size_t n = size_t(std::min<uint64_t>(size, r->data->size() - r->pos));
                           std::memcpy(buf, r->data->data() + r->pos, n);
                           r->pos += n;
                           return int64_t(n);
                         }};
    return state_->load(plugin_, &stream);
  }

  void idle() override {
    if (callback_.exchange(false)) plugin_->on_main_thread(plugin_);
  }

  bool wantsRestart() override {
    return restart_.exchange(false);
  }

private:
  static ClapPlugin* self(const clap_host* h) {
    return static_cast<ClapPlugin*>(h->host_data);
  }

  static bool pushOut(const clap_output_events*, const clap_event_header_t*) {
    // Gestures and value echoes from the plugin; the remote reads values back on demand.
    return true;
  }

  static bool toId(const std::string& id, clap_id& out) {
    char* end = nullptr;
    const unsigned long v = std::strtoul(id.c_str(), &end, 10);
    if (id.empty() || !end || *end) return false;
    out = clap_id(v);
    return true;
  }

  /** A value set but not yet seen by the plugin wins over what get_value says. */
  double pendingValue(clap_id id, double fallback) {
    std::lock_guard lock(pendingMutex_);
    for (auto it = pending_.rbegin(); it != pending_.rend(); ++it) {
      if (it->param_id == id) return it->value;
    }
    return fallback;
  }

  std::string text(clap_id id, double value) {
    char buf[128] = {};
    if (params_->value_to_text && params_->value_to_text(plugin_, id, value, buf, sizeof(buf)) && buf[0]) {
      return buf;
    }
    char num[64];
    std::snprintf(num, sizeof(num), "%.3g", value);
    return num;
  }

  void flush() {
    if (!params_ || !params_->flush) return;
    EventQueue queue;
    {
      std::lock_guard lock(pendingMutex_);
      if (pending_.empty()) return;
      queue.events.swap(pending_);
    }
    const clap_input_events in = queue.input();
    clap_output_events out {this, &ClapPlugin::pushOut};
    // Active: the audio thread; inactive: the main thread (CLAP's rule).
    if (active_) audio_.run([&] { params_->flush(plugin_, &in, &out); });
    else params_->flush(plugin_, &in, &out);
  }

  static const void* hostExtension(const clap_host* h, const char* id) {
    auto* p = self(h);
    if (!std::strcmp(id, CLAP_EXT_THREAD_CHECK)) return &p->threadCheck_;
    if (!std::strcmp(id, CLAP_EXT_LOG)) return &p->log_;
    if (!std::strcmp(id, CLAP_EXT_PARAMS)) return &p->hostParams_;
    if (!std::strcmp(id, CLAP_EXT_LATENCY)) return &p->hostLatency_;
    if (!std::strcmp(id, CLAP_EXT_STATE)) return &p->hostState_;
    if (!std::strcmp(id, CLAP_EXT_AUDIO_PORTS)) return &p->hostPorts_;
    return nullptr;
  }

  AudioThread& audio_;
  clap_host host_ {};
  const clap_plugin* plugin_ = nullptr;
  const clap_plugin_params* params_ = nullptr;
  const clap_plugin_state* state_ = nullptr;
  const clap_plugin_latency* latency_ = nullptr;
  const clap_plugin_audio_ports* ports_ = nullptr;
  uint32_t inChannels_ = 2;
  uint32_t outChannels_ = 2;
  PortBuffers inPorts_;
  PortBuffers outPorts_;
  bool active_ = false;
  bool processing_ = false;
  uint64_t steadyTime_ = 0;
  std::atomic<bool> restart_ {false};
  std::atomic<bool> callback_ {false};
  std::mutex pendingMutex_;
  std::vector<clap_event_param_value> pending_;

  // The audio thread is AudioThread's; every other thread asking is treated as main.
  clap_host_thread_check threadCheck_ {
      [](const clap_host* h) { return !self(h)->audio_.isCurrent(); },
      [](const clap_host* h) { return self(h)->audio_.isCurrent(); },
  };
  clap_host_log log_ {[](const clap_host*, clap_log_severity severity, const char* msg) {
    if (severity >= CLAP_LOG_WARNING && msg) std::fprintf(stderr, "harbor-fx clap: %s\n", msg);
  }};
  clap_host_params hostParams_ {
      [](const clap_host*, clap_param_rescan_flags) {},
      [](const clap_host*, clap_id, clap_param_clear_flags) {},
      [](const clap_host*) {},
  };
  clap_host_latency hostLatency_ {[](const clap_host*) {}};
  clap_host_state hostState_ {[](const clap_host*) {}};
  clap_host_audio_ports hostPorts_ {
      [](const clap_host*, uint32_t) { return false; },
      [](const clap_host* h, uint32_t) { self(h)->restart_ = true; },
  };
};

bool hasFeature(const clap_plugin_descriptor* d, const char* feature) {
  if (!d->features) return false;
  for (auto f = d->features; *f; ++f) {
    if (!std::strcmp(*f, feature)) return true;
  }
  return false;
}

void addDir(std::vector<fs::path>& dirs, const fs::path& dir) {
  if (!dir.empty()) dirs.push_back(dir);
}

std::vector<fs::path> searchPaths() {
  std::vector<fs::path> dirs;
  if (const char* env = std::getenv("CLAP_PATH")) {
#if defined(_WIN32)
    const char sep = ';';
#else
    const char sep = ':';
#endif
    std::string all = env;
    size_t start = 0;
    while (start <= all.size()) {
      const size_t end = all.find(sep, start);
      addDir(dirs, all.substr(start, end == std::string::npos ? std::string::npos : end - start));
      if (end == std::string::npos) break;
      start = end + 1;
    }
  }
  const char* home = std::getenv("HOME");
#if defined(__APPLE__)
  if (home) addDir(dirs, fs::path(home) / "Library/Audio/Plug-Ins/CLAP");
  addDir(dirs, "/Library/Audio/Plug-Ins/CLAP");
#elif defined(_WIN32)
  if (const char* common = std::getenv("COMMONPROGRAMFILES")) addDir(dirs, fs::path(common) / "CLAP");
  if (const char* local = std::getenv("LOCALAPPDATA")) addDir(dirs, fs::path(local) / "Programs/Common/CLAP");
#else
  if (home) addDir(dirs, fs::path(home) / ".clap");
  addDir(dirs, "/usr/lib/clap");
  addDir(dirs, "/usr/local/lib/clap");
#endif
  return dirs;
}

} // namespace

std::vector<FxDescriptor> clapList() {
  std::vector<FxDescriptor> out;
  for (const auto& dir : searchPaths()) {
    std::error_code ec;
    if (!fs::is_directory(dir, ec)) continue;
    // Vendors nest bundles in folders (Audiority/…); a bundle itself is not walked into.
    fs::recursive_directory_iterator it(dir, fs::directory_options::skip_permission_denied, ec), end;
    for (; it != end; it.increment(ec)) {
      if (ec) break;
      const auto& p = it->path();
      if (p.extension() == ".clap") {
        FxDescriptor d;
        d.format = "clap";
        d.path = p.string();
        out.push_back(std::move(d));
        if (it->is_directory(ec)) it.disable_recursion_pending();
      }
    }
  }
  return out;
}

std::vector<FxDescriptor> clapDescribe(const std::string& path, std::string& error) {
  std::vector<FxDescriptor> out;
  const ClapLibrary* lib = openLibrary(path, error);
  if (!lib) return out;
  AudioThread audio;
  const uint32_t n = lib->factory->get_plugin_count(lib->factory);
  for (uint32_t i = 0; i < n; ++i) {
    const clap_plugin_descriptor* d = lib->factory->get_plugin_descriptor(lib->factory, i);
    if (!d || !d->id) continue;
    FxDescriptor desc;
    desc.format = "clap";
    desc.path = path;
    desc.id = d->id;
    desc.name = d->name ? d->name : d->id;
    desc.vendor = d->vendor ? d->vendor : "";
    desc.version = d->version ? d->version : "";
    if (d->features) {
      for (auto f = d->features; *f; ++f) desc.features.emplace_back(*f);
    }
    if (hasFeature(d, CLAP_PLUGIN_FEATURE_AUDIO_EFFECT) && !hasFeature(d, CLAP_PLUGIN_FEATURE_INSTRUMENT)) {
      ClapPlugin probe(audio);
      std::string why;
      if (probe.create(*lib, d->id, why)) {
        uint32_t in = 0, outCh = 0;
        probe.mainPorts(in, outCh);
        desc.stereo = in == 2 && outCh == 2;
      }
    }
    out.push_back(std::move(desc));
  }
  return out;
}

std::unique_ptr<FxPlugin> clapLoad(const std::string& path, const std::string& id, AudioThread& audio,
                                   std::string& error) {
  const ClapLibrary* lib = openLibrary(path, error);
  if (!lib) return nullptr;
  auto plugin = std::make_unique<ClapPlugin>(audio);
  if (!plugin->create(*lib, id, error)) return nullptr;
  return plugin;
}
