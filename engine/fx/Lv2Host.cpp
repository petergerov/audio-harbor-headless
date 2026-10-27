// LV2 through lilv (Linux): the plugins Linux and the Pi have (LSP, x42, Calf, ZAM via apt).
#include "FxPlugin.h"
#include "MainLoop.h"

#include <dlfcn.h>
#include <lilv/lilv.h>
#include <lv2/atom/atom.h>
#include <lv2/atom/util.h>
#include <lv2/data-access/data-access.h>
#include <lv2/instance-access/instance-access.h>
#include <lv2/ui/ui.h>
#include <lv2/buf-size/buf-size.h>
#include <lv2/core/lv2.h>
#include <lv2/log/log.h>
#include <lv2/options/options.h>
#include <lv2/state/state.h>
#include <lv2/units/units.h>
#include <lv2/urid/urid.h>
#include <lv2/worker/worker.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <map>
#include <mutex>
#include <string>
#include <vector>

namespace {

/** One lilv world for the process: loading every bundle takes a while. */
struct World {
  LilvWorld* world = nullptr;
  LilvNode* audioPort;
  LilvNode* controlPort;
  LilvNode* inputPort;
  LilvNode* outputPort;
  LilvNode* atomPort;
  LilvNode* cvPort;
  LilvNode* toggled;
  LilvNode* integer;
  LilvNode* enumeration;
  LilvNode* reportsLatency;
  LilvNode* designation;
  LilvNode* enabled;
  LilvNode* optional;
  LilvNode* unit;
  LilvNode* unitSymbol;
  LilvNode* isSideChain;
  LilvNode* minimumSize;

  World() {
    world = lilv_world_new();
    lilv_world_load_all(world);
    audioPort = lilv_new_uri(world, LV2_CORE__AudioPort);
    controlPort = lilv_new_uri(world, LV2_CORE__ControlPort);
    inputPort = lilv_new_uri(world, LV2_CORE__InputPort);
    outputPort = lilv_new_uri(world, LV2_CORE__OutputPort);
    atomPort = lilv_new_uri(world, LV2_ATOM__AtomPort);
    cvPort = lilv_new_uri(world, LV2_CORE__CVPort);
    toggled = lilv_new_uri(world, LV2_CORE__toggled);
    integer = lilv_new_uri(world, LV2_CORE__integer);
    enumeration = lilv_new_uri(world, LV2_CORE__enumeration);
    reportsLatency = lilv_new_uri(world, LV2_CORE__reportsLatency);
    designation = lilv_new_uri(world, LV2_CORE__designation);
    enabled = lilv_new_uri(world, LV2_CORE__enabled);
    optional = lilv_new_uri(world, LV2_CORE__connectionOptional);
    unit = lilv_new_uri(world, LV2_UNITS__unit);
    unitSymbol = lilv_new_uri(world, LV2_UNITS__symbol);
    isSideChain = lilv_new_uri(world, "http://lv2plug.in/ns/lv2core#isSideChain");
    minimumSize = lilv_new_uri(world, "http://lv2plug.in/ns/ext/resize-port#minimumSize");
  }
};

World& world() {
  static World w;
  return w;
}

/** URIDs for the plugins; one table for the process. */
class Urids {
public:
  LV2_URID map(const char* uri) {
    std::lock_guard lock(mutex_);
    auto it = ids_.find(uri);
    if (it != ids_.end()) return it->second;
    uris_.emplace_back(uri);
    const LV2_URID id = LV2_URID(uris_.size());
    ids_.emplace(uri, id);
    return id;
  }
  const char* unmap(LV2_URID id) {
    std::lock_guard lock(mutex_);
    return id >= 1 && id <= uris_.size() ? uris_[id - 1].c_str() : nullptr;
  }

  LV2_URID_Map mapFeature {this, [](LV2_URID_Map_Handle h, const char* uri) { return static_cast<Urids*>(h)->map(uri); }};
  LV2_URID_Unmap unmapFeature {this, [](LV2_URID_Unmap_Handle h, LV2_URID id) {
                                 return static_cast<Urids*>(h)->unmap(id);
                               }};

private:
  std::mutex mutex_;
  std::map<std::string, LV2_URID> ids_;
  std::vector<std::string> uris_;  // stable: unmap hands out c_str()
};

Urids& urids() {
  static Urids u;
  return u;
}

int logPrintf(LV2_Log_Handle, LV2_URID type, const char* fmt, ...) {
  if (type == urids().map(LV2_LOG__Trace)) return 0;
  va_list args;
  va_start(args, fmt);
  std::fprintf(stderr, "harbor-fx lv2: ");
  const int n = std::vfprintf(stderr, fmt, args);
  va_end(args);
  return n;
}

int logVPrintf(LV2_Log_Handle, LV2_URID type, const char* fmt, va_list args) {
  if (type == urids().map(LV2_LOG__Trace)) return 0;
  std::fprintf(stderr, "harbor-fx lv2: ");
  return std::vfprintf(stderr, fmt, args);
}

LV2_Log_Log g_log {nullptr, logPrintf, logVPrintf};

std::string nodeString(LilvNode* node) {
  if (!node) return {};
  std::string s = lilv_node_as_string(node);
  lilv_node_free(node);
  return s;
}

struct PortInfo {
  uint32_t index = 0;
  std::string symbol;
  std::string name;
  bool audio = false;
  bool control = false;
  bool atom = false;
  bool cv = false;
  bool input = false;
  bool sideChain = false;
  bool toggled = false;
  bool integer = false;
  bool enumeration = false;
  bool latency = false;
  bool enabled = false;
  float min = 0, max = 1, def = 0;
  /** Atom ports: the buffer the plugin asks for (rsz:minimumSize). */
  uint32_t minimumSize = 0;
  std::string unit;
  std::vector<std::pair<float, std::string>> scalePoints;
};

std::vector<PortInfo> portsOf(const LilvPlugin* p) {
  World& w = world();
  const uint32_t n = lilv_plugin_get_num_ports(p);
  std::vector<float> mins(n), maxs(n), defs(n);
  lilv_plugin_get_port_ranges_float(p, mins.data(), maxs.data(), defs.data());
  std::vector<PortInfo> out;
  for (uint32_t i = 0; i < n; ++i) {
    const LilvPort* port = lilv_plugin_get_port_by_index(p, i);
    PortInfo info;
    info.index = i;
    info.symbol = lilv_node_as_string(lilv_port_get_symbol(p, port));
    info.name = nodeString(lilv_port_get_name(p, port));
    info.audio = lilv_port_is_a(p, port, w.audioPort);
    info.control = lilv_port_is_a(p, port, w.controlPort);
    info.atom = lilv_port_is_a(p, port, w.atomPort);
    info.cv = lilv_port_is_a(p, port, w.cvPort);
    info.input = lilv_port_is_a(p, port, w.inputPort);
    info.sideChain = lilv_port_has_property(p, port, w.isSideChain);
    info.toggled = lilv_port_has_property(p, port, w.toggled);
    info.integer = lilv_port_has_property(p, port, w.integer);
    info.enumeration = lilv_port_has_property(p, port, w.enumeration);
    info.latency = lilv_port_has_property(p, port, w.reportsLatency);
    if (LilvNodes* des = lilv_port_get_value(p, port, w.designation)) {
      info.enabled = lilv_nodes_contains(des, w.enabled);
      lilv_nodes_free(des);
    }
    info.min = std::isnan(mins[i]) ? 0.0f : mins[i];
    info.max = std::isnan(maxs[i]) ? 1.0f : maxs[i];
    info.def = std::isnan(defs[i]) ? info.min : defs[i];
    if (LilvNode* size = lilv_port_get(p, port, w.minimumSize)) {
      info.minimumSize = uint32_t(std::max(0, lilv_node_as_int(size)));
      lilv_node_free(size);
    }
    if (LilvNode* unit = lilv_port_get(p, port, w.unit)) {
      if (LilvNode* sym = lilv_world_get(w.world, unit, w.unitSymbol, nullptr)) {
        info.unit = lilv_node_as_string(sym);
        lilv_node_free(sym);
      }
      lilv_node_free(unit);
    }
    if (LilvScalePoints* points = lilv_port_get_scale_points(p, port)) {
      LILV_FOREACH (scale_points, it, points) {
        const LilvScalePoint* sp = lilv_scale_points_get(points, it);
        info.scalePoints.emplace_back(lilv_node_as_float(lilv_scale_point_get_value(sp)),
                                      lilv_node_as_string(lilv_scale_point_get_label(sp)));
      }
      lilv_scale_points_free(points);
    }
    out.push_back(std::move(info));
  }
  return out;
}

/** Main audio ports: the first two non-sidechain inputs and outputs. */
void mainAudio(const std::vector<PortInfo>& ports, std::vector<uint32_t>& ins, std::vector<uint32_t>& outs) {
  ins.clear();
  outs.clear();
  for (const auto& p : ports) {
    if (!p.audio || p.sideChain) continue;
    (p.input ? ins : outs).push_back(p.index);
  }
}

bool isStereo(const std::vector<PortInfo>& ports) {
  std::vector<uint32_t> ins, outs;
  mainAudio(ports, ins, outs);
  return ins.size() == 2 && outs.size() == 2;
}

const LilvPlugin* findPlugin(const std::string& uri) {
  World& w = world();
  LilvNode* node = lilv_new_uri(w.world, uri.c_str());
  const LilvPlugin* p = lilv_plugins_get_by_uri(lilv_world_get_all_plugins(w.world), node);
  lilv_node_free(node);
  return p;
}

FxDescriptor describe(const LilvPlugin* p) {
  FxDescriptor d;
  d.format = "lv2";
  d.id = lilv_node_as_uri(lilv_plugin_get_uri(p));
  char* path = lilv_file_uri_parse(lilv_node_as_uri(lilv_plugin_get_bundle_uri(p)), nullptr);
  d.path = path ? path : "";
  lilv_free(path);
  d.name = nodeString(lilv_plugin_get_name(p));
  d.vendor = nodeString(lilv_plugin_get_author_name(p));
  if (const LilvPluginClass* cls = lilv_plugin_get_class(p)) {
    d.features.emplace_back(lilv_node_as_string(lilv_plugin_class_get_label(cls)));
  }
  d.stereo = isStereo(portsOf(p));
  return d;
}

class Lv2Plugin final : public FxPlugin {
public:
  Lv2Plugin(const LilvPlugin* plugin, AudioThread& audio) : plugin_(plugin), audio_(audio) {
    ports_ = portsOf(plugin);
    mainAudio(ports_, mainIns_, mainOuts_);
    controls_.resize(ports_.size(), 0.0f);
    for (const auto& p : ports_) {
      if (p.control) controls_[p.index] = p.def;
    }
    findX11Ui();
  }

  ~Lv2Plugin() override {
    closeEditor();
    deactivate();
    if (instance_) lilv_instance_free(instance_);
  }

  bool activate(double rate, uint32_t maxBlock, std::string& error) override {
    // LV2 takes the rate at instantiation: a new rate is a new instance, settings carried over.
    std::vector<uint8_t> state;
    if (instance_ && rate != rate_) {
      // The UI holds the instance it was given: it goes first.
      closeEditor();
      saveState(state);
      deactivate();
      lilv_instance_free(instance_);
      instance_ = nullptr;
    }
    deactivate();
    rate_ = rate;
    maxBlock_ = maxBlock;
    if (!instance_) {
      buildFeatures();
      instance_ = lilv_plugin_instantiate(plugin_, rate, features_.data());
      if (!instance_) {
        error = "The plugin could not start (a feature it needs is missing)";
        return false;
      }
      worker_ = static_cast<const LV2_Worker_Interface*>(
          lilv_instance_get_extension_data(instance_, LV2_WORKER__interface));
      stateIface_ = static_cast<const LV2_State_Interface*>(
          lilv_instance_get_extension_data(instance_, LV2_STATE__interface));
      connect();
      if (!state.empty()) loadState(state);
      if (!pendingState_.empty()) {
        loadState(pendingState_);
        pendingState_.clear();
      }
    }
    lilv_instance_activate(instance_);
    active_ = true;
    return true;
  }

  void deactivate() override {
    if (instance_ && active_) lilv_instance_deactivate(instance_);
    active_ = false;
  }

  void reset() override {
    // LV2 has no reset: deactivate / activate clears the plugin's buffers.
    if (!instance_ || !active_) return;
    lilv_instance_deactivate(instance_);
    lilv_instance_activate(instance_);
  }

  void process(const float* const* in, float* const* out, uint32_t frames) override {
    if (!active_) {
      std::memcpy(out[0], in[0], frames * sizeof(float));
      std::memcpy(out[1], in[1], frames * sizeof(float));
      return;
    }
    {
      std::lock_guard lock(controlMutex_);
      for (const auto& [index, value] : pendingControls_) controls_[index] = value;
      pendingControls_.clear();
    }
    lilv_instance_connect_port(instance_, mainIns_[0], const_cast<float*>(in[0]));
    lilv_instance_connect_port(instance_, mainIns_[1], const_cast<float*>(in[1]));
    lilv_instance_connect_port(instance_, mainOuts_[0], out[0]);
    lilv_instance_connect_port(instance_, mainOuts_[1], out[1]);
    for (auto& a : atomIns_) a.reset(urids().map(LV2_ATOM__Sequence));
    for (auto& a : atomOuts_) a.prepareOutput(urids().map(LV2_ATOM__Chunk));
    const bool ui = uiActive_.load();
    if (ui) sendUiAtoms();
    lilv_instance_run(instance_, frames);
    if (ui) collectUiAtoms();
    runWorkerResponses();
  }

  uint32_t latency() override {
    for (const auto& p : ports_) {
      if (p.latency && p.control && !p.input) return uint32_t(std::max(0.0f, controls_[p.index]));
    }
    return 0;
  }

  std::vector<FxParam> params() override {
    std::vector<FxParam> out;
    std::lock_guard lock(controlMutex_);
    for (const auto& p : ports_) {
      // Output controls are the plugin's meters; the latency report is not one.
      if (!p.control || p.latency) continue;
      FxParam param;
      param.id = p.symbol;
      param.name = p.name;
      param.min = p.min;
      param.max = p.max;
      param.def = p.def;
      auto pending = pendingControls_.find(p.index);
      param.value = pending != pendingControls_.end() ? pending->second : controls_[p.index];
      param.stepped = p.toggled || p.integer || p.enumeration;
      param.isBypass = p.enabled;
      param.readOnly = !p.input;
      param.text = text(p, float(param.value));
      param.options = options(p);
      out.push_back(std::move(param));
    }
    return out;
  }

  bool setParam(const std::string& id, double value) override {
    for (const auto& p : ports_) {
      if (p.control && p.input && p.symbol == id) {
        const float v = float(std::clamp(value, double(p.min), double(p.max)));
        std::lock_guard lock(controlMutex_);
        if (active_) pendingControls_[p.index] = v;
        else controls_[p.index] = v;
        return true;
      }
    }
    return false;
  }

  bool parse(const std::string& id, const std::string& text, double& value) override {
    for (const auto& p : ports_) {
      if (!p.control || !p.input || p.symbol != id) continue;
      for (const auto& sp : p.scalePoints) {
        if (sp.second == text) {
          value = sp.first;
          return true;
        }
      }
      char* end = nullptr;
      value = std::strtod(text.c_str(), &end);
      return end && end != text.c_str();
    }
    return false;
  }

  bool saveState(std::vector<uint8_t>& out) override {
    out.clear();
    if (!instance_) return false;
    LilvState* state = lilv_state_new_from_instance(
        plugin_, instance_, &urids().mapFeature, nullptr, nullptr, nullptr, nullptr,
        [](const char* symbol, void* self, uint32_t* size, uint32_t* type) -> const void* {
          auto* me = static_cast<Lv2Plugin*>(self);
          for (const auto& p : me->ports_) {
            if (p.control && p.input && p.symbol == symbol) {
              *size = sizeof(float);
              *type = urids().map(LV2_ATOM__Float);
              return &me->controls_[p.index];
            }
          }
          *size = 0;
          *type = 0;
          return nullptr;
        },
        this, LV2_STATE_IS_POD | LV2_STATE_IS_PORTABLE, features_.data());
    if (!state) return false;
    char* text = lilv_state_to_string(world().world, &urids().mapFeature, &urids().unmapFeature, state,
                                      "urn:harbor:state", nullptr);
    lilv_state_free(state);
    if (!text) return false;
    out.assign(text, text + std::strlen(text));
    lilv_free(text);
    return true;
  }

  bool loadState(const std::vector<uint8_t>& in) override {
    if (!instance_) {
      // Not instantiated until the first track's rate is known: restore then.
      pendingState_ = in;
      return true;
    }
    {
      // Values set before but not yet processed would undo the state on the next block.
      std::lock_guard lock(controlMutex_);
      pendingControls_.clear();
    }
    const std::string text(in.begin(), in.end());
    LilvState* state = lilv_state_new_from_string(world().world, &urids().mapFeature, text.c_str());
    if (!state) return false;
    lilv_state_restore(
        state, instance_,
        [](const char* symbol, void* self, const void* value, uint32_t size, uint32_t type) {
          auto* me = static_cast<Lv2Plugin*>(self);
          if (type != urids().map(LV2_ATOM__Float) || size != sizeof(float)) return;
          for (const auto& p : me->ports_) {
            if (p.control && p.input && p.symbol == symbol) me->controls_[p.index] = *static_cast<const float*>(value);
          }
        },
        this, 0, features_.data());
    lilv_state_free(state);
    return true;
  }

  /** An X11 UI of the plugin's (ui:X11UI), embedded; Linux desktops only. */
  bool hasEditor() override { return !uiUri_.empty() && mainloop::hasScreen(); }

  bool openEditor(void* parent, EditorFrame& frame, uint32_t& width, uint32_t& height, std::string& error) override {
    if (!instance_) {
      error = "Play a track first: the plugin starts at the music's rate";
      return false;
    }
    const LV2UI_Descriptor* desc = uiDescriptor(error);
    if (!desc) return false;
    frame_ = &frame;
    uiWidth_ = 640;
    uiHeight_ = 400;
    uiResize_ = {this, [](LV2UI_Feature_Handle h, int w, int hgt) {
                   auto* me = static_cast<Lv2Plugin*>(h);
                   me->uiWidth_ = uint32_t(std::max(1, w));
                   me->uiHeight_ = uint32_t(std::max(1, hgt));
                   if (me->frame_ && me->ui_) me->frame_->resize(me->uiWidth_, me->uiHeight_);
                   return 0;
                 }};
    dataAccess_ = {lilv_instance_get_descriptor(instance_)->extension_data};
    uiFeatureList_ = {
        {LV2_UI__parent, parent},
        {LV2_UI__resize, &uiResize_},
        {LV2_UI__idleInterface, nullptr},
        {LV2_URID__map, &urids().mapFeature},
        {LV2_URID__unmap, &urids().unmapFeature},
        {LV2_INSTANCE_ACCESS_URI, lilv_instance_get_handle(instance_)},
        {LV2_DATA_ACCESS_URI, &dataAccess_},
        {LV2_OPTIONS__options, options_.data()},
        {LV2_LOG__log, &g_log},
    };
    uiFeatures_.clear();
    for (auto& f : uiFeatureList_) uiFeatures_.push_back(&f);
    uiFeatures_.push_back(nullptr);
    LV2UI_Widget widget = nullptr;
    LV2UI_Handle handle = desc->instantiate(desc, lilv_node_as_uri(lilv_plugin_get_uri(plugin_)), uiBundle_.c_str(),
                                            &Lv2Plugin::uiWrite, this, &widget, uiFeatures_.data());
    if (!handle) {
      frame_ = nullptr;
      error = "The plugin's editor did not open";
      return false;
    }
    uiDesc_ = desc;
    uiIdle_ = desc->extension_data ? static_cast<const LV2UI_Idle_Interface*>(desc->extension_data(LV2_UI__idleInterface)) : nullptr;
    uiShown_.assign(ports_.size(), NAN);
    ui_ = handle;
    uiActive_ = true;
    uiTimer_ = mainloop::addTimer(33, [this] { uiTick(); });
    uiTick();
    width = uiWidth_;
    height = uiHeight_;
    return true;
  }

  void closeEditor() override {
    if (!ui_) return;
    mainloop::remove(uiTimer_);
    uiTimer_ = 0;
    LV2UI_Handle handle = ui_;
    uiActive_ = false;
    {
      std::lock_guard lock(uiMutex_);
      ui_ = nullptr;
      toPlugin_.clear();
      toUi_.clear();
    }
    uiDesc_->cleanup(handle);
    frame_ = nullptr;
  }

  /** pset:Preset resources related to the plugin: its bundle's, and those saved in ~/.lv2. */
  std::vector<FxPreset> presets() override {
    World& w = world();
    std::vector<FxPreset> out;
    LilvNode* presetClass = lilv_new_uri(w.world, "http://lv2plug.in/ns/ext/presets#Preset");
    LilvNode* label = lilv_new_uri(w.world, "http://www.w3.org/2000/01/rdf-schema#label");
    LilvNodes* related = lilv_plugin_get_related(plugin_, presetClass);
    LILV_FOREACH (nodes, i, related) {
      const LilvNode* preset = lilv_nodes_get(related, i);
      lilv_world_load_resource(w.world, preset);
      std::string name = lilv_node_as_uri(preset);
      if (LilvNode* l = lilv_world_get(w.world, preset, label, nullptr)) {
        name = lilv_node_as_string(l);
        lilv_node_free(l);
      }
      out.push_back({lilv_node_as_uri(preset), name, "Presets"});
    }
    lilv_nodes_free(related);
    lilv_node_free(label);
    lilv_node_free(presetClass);
    std::sort(out.begin(), out.end(), [](const FxPreset& a, const FxPreset& b) { return a.name < b.name; });
    return out;
  }

  bool loadPreset(const std::string& id, std::string& error) override {
    World& w = world();
    LilvNode* preset = lilv_new_uri(w.world, id.c_str());
    LilvState* state = preset ? lilv_state_new_from_world(w.world, &urids().mapFeature, preset) : nullptr;
    lilv_node_free(preset);
    char* text = state ? lilv_state_to_string(w.world, &urids().mapFeature, &urids().unmapFeature, state,
                                              "urn:harbor:state", nullptr)
                       : nullptr;
    if (state) lilv_state_free(state);
    // As saved settings: restored at once, or when the plugin is instantiated.
    const bool ok = text && loadState(std::vector<uint8_t>(text, text + std::strlen(text)));
    if (text) lilv_free(text);
    if (!ok) error = "The plugin did not take that preset";
    return ok;
  }

private:
  /** The plugin's first X11 UI: its URI, binary and bundle. */
  void findX11Ui() {
    World& w = world();
    LilvNode* x11 = lilv_new_uri(w.world, LV2_UI__X11UI);
    LilvUIs* uis = lilv_plugin_get_uis(plugin_);
    LILV_FOREACH (uis, i, uis) {
      const LilvUI* ui = lilv_uis_get(uis, i);
      if (!lilv_ui_is_a(ui, x11)) continue;
      char* binary = lilv_file_uri_parse(lilv_node_as_uri(lilv_ui_get_binary_uri(ui)), nullptr);
      char* bundle = lilv_file_uri_parse(lilv_node_as_uri(lilv_ui_get_bundle_uri(ui)), nullptr);
      if (binary && bundle) {
        uiUri_ = lilv_node_as_uri(lilv_ui_get_uri(ui));
        uiBinary_ = binary;
        uiBundle_ = bundle;
      }
      lilv_free(binary);
      lilv_free(bundle);
      if (!uiUri_.empty()) break;
    }
    lilv_uis_free(uis);
    lilv_node_free(x11);
  }

  /** The UI library stays loaded for the life of harbor-fx, like plugin libraries. */
  const LV2UI_Descriptor* uiDescriptor(std::string& error) {
    void* lib = dlopen(uiBinary_.c_str(), RTLD_NOW | RTLD_LOCAL);
    using Entry = const LV2UI_Descriptor* (*)(uint32_t);
    auto entry = lib ? reinterpret_cast<Entry>(dlsym(lib, "lv2ui_descriptor")) : nullptr;
    for (uint32_t i = 0; entry; ++i) {
      const LV2UI_Descriptor* d = entry(i);
      if (!d) break;
      if (uiUri_ == d->URI) return d;
    }
    error = "The plugin's editor could not be loaded";
    return nullptr;
  }

  /** From the UI: a control's new value, or an atom for one of the plugin's atom inputs. */
  static void uiWrite(LV2UI_Controller controller, uint32_t port, uint32_t size, uint32_t protocol, const void* buffer) {
    auto* me = static_cast<Lv2Plugin*>(controller);
    if (port >= me->ports_.size() || !buffer) return;
    if (protocol == 0 && size == sizeof(float)) {
      const float v = *static_cast<const float*>(buffer);
      std::lock_guard lock(me->controlMutex_);
      if (me->active_) me->pendingControls_[port] = v;
      else me->controls_[port] = v;
      return;
    }
    if (protocol == urids().map(LV2_ATOM__eventTransfer) && size >= sizeof(LV2_Atom)) {
      const auto* bytes = static_cast<const uint8_t*>(buffer);
      std::lock_guard lock(me->uiMutex_);
      me->toPlugin_.push_back({port, std::vector<uint8_t>(bytes, bytes + size)});
    }
  }

  /** Audio thread, before run: the UI's atoms into the plugin's atom inputs. */
  void sendUiAtoms() {
    std::lock_guard lock(uiMutex_);
    for (const auto& [port, atom] : toPlugin_) {
      for (auto& in : atomIns_) {
        if (in.port != port) continue;
        std::vector<uint8_t> ev(sizeof(LV2_Atom_Event) - sizeof(LV2_Atom) + atom.size());
        auto* event = reinterpret_cast<LV2_Atom_Event*>(ev.data());
        event->time.frames = 0;
        std::memcpy(&event->body, atom.data(), atom.size());
        lv2_atom_sequence_append_event(in.seq(), uint32_t(in.data.size() - sizeof(LV2_Atom)), event);
      }
    }
    toPlugin_.clear();
  }

  /** Audio thread, after run: what the plugin's atom outputs say, for the UI. */
  void collectUiAtoms() {
    std::lock_guard lock(uiMutex_);
    for (auto& out : atomOuts_) {
      LV2_Atom_Sequence* seq = out.seq();
      if (seq->atom.type != urids().map(LV2_ATOM__Sequence)) continue;
      LV2_ATOM_SEQUENCE_FOREACH (seq, ev) {
        const auto* bytes = reinterpret_cast<const uint8_t*>(&ev->body);
        toUi_.push_back({out.port, std::vector<uint8_t>(bytes, bytes + sizeof(LV2_Atom) + ev->body.size)});
      }
    }
  }

  /** Main thread, ~30 times a second: changed controls and the plugin's atoms to the UI, its idle. */
  void uiTick() {
    if (!ui_) return;
    std::vector<std::pair<uint32_t, float>> controls;
    {
      std::lock_guard lock(controlMutex_);
      for (const auto& p : ports_) {
        if (!p.control) continue;
        auto pending = pendingControls_.find(p.index);
        const float v = pending != pendingControls_.end() ? pending->second : controls_[p.index];
        if (!(v == uiShown_[p.index])) controls.push_back({p.index, v});
      }
    }
    for (const auto& [index, v] : controls) {
      uiShown_[index] = v;
      uiDesc_->port_event(ui_, index, sizeof(float), 0, &v);
    }
    std::vector<std::pair<uint32_t, std::vector<uint8_t>>> atoms;
    {
      std::lock_guard lock(uiMutex_);
      atoms.swap(toUi_);
    }
    const LV2_URID transfer = urids().map(LV2_ATOM__eventTransfer);
    for (const auto& [port, atom] : atoms) uiDesc_->port_event(ui_, port, uint32_t(atom.size()), transfer, atom.data());
    if (uiIdle_) uiIdle_->idle(ui_);
  }

  /** An atom sequence port: empty in, room to write out. */
  struct AtomBuffer {
    AtomBuffer(uint32_t port, uint32_t minimum) : port(port), data(std::max<size_t>(65536, minimum)) {}
    uint32_t port;
    std::vector<uint8_t> data;
    LV2_Atom_Sequence* seq() { return reinterpret_cast<LV2_Atom_Sequence*>(data.data()); }
    void reset(LV2_URID sequence) {
      seq()->atom.size = sizeof(LV2_Atom_Sequence_Body);
      seq()->atom.type = sequence;
      seq()->body.unit = 0;
      seq()->body.pad = 0;
    }
    void prepareOutput(LV2_URID chunk) {
      seq()->atom.size = uint32_t(data.size() - sizeof(LV2_Atom));
      seq()->atom.type = chunk;
    }
  };

  /** Scale points, else on / off, else the integers of a small stepped range. */
  std::vector<std::pair<double, std::string>> options(const PortInfo& p) const {
    std::vector<std::pair<double, std::string>> out;
    if (!p.scalePoints.empty()) {
      for (const auto& sp : p.scalePoints) out.emplace_back(sp.first, sp.second);
    } else if (p.toggled) {
      out = {{0.0, "Off"}, {1.0, "On"}};
    } else if ((p.integer || p.enumeration) && p.max - p.min <= kMaxOptions) {
      for (float v = std::ceil(p.min); v <= p.max; v += 1) out.emplace_back(v, text(p, v));
    }
    return out;
  }

  std::string text(const PortInfo& p, float v) const {
    for (const auto& sp : p.scalePoints) {
      if (std::fabs(sp.first - v) < 1e-4f) return sp.second;
    }
    if (p.toggled) return v > 0.5f ? "On" : "Off";
    char buf[64];
    if (p.integer || p.enumeration) std::snprintf(buf, sizeof(buf), "%d", int(std::lround(v)));
    else std::snprintf(buf, sizeof(buf), std::fabs(v) >= 100 ? "%.0f" : "%.2f", v);
    std::string s = buf;
    if (!p.unit.empty()) s += " " + p.unit;
    return s;
  }

  void buildFeatures() {
    LV2_URID_Map* map = &urids().mapFeature;
    minBlock_ = 1;
    nominalBlock_ = int32_t(maxBlock_);
    maxBlockInt_ = int32_t(maxBlock_);
    rateFloat_ = float(rate_);
    options_ = {
        {LV2_OPTIONS_INSTANCE, 0, map->map(map->handle, LV2_BUF_SIZE__minBlockLength), sizeof(int32_t),
         map->map(map->handle, LV2_ATOM__Int), &minBlock_},
        {LV2_OPTIONS_INSTANCE, 0, map->map(map->handle, LV2_BUF_SIZE__maxBlockLength), sizeof(int32_t),
         map->map(map->handle, LV2_ATOM__Int), &maxBlockInt_},
        {LV2_OPTIONS_INSTANCE, 0, map->map(map->handle, LV2_BUF_SIZE__nominalBlockLength), sizeof(int32_t),
         map->map(map->handle, LV2_ATOM__Int), &nominalBlock_},
        {LV2_OPTIONS_INSTANCE, 0, map->map(map->handle, "http://lv2plug.in/ns/ext/parameters#sampleRate"),
         sizeof(float), map->map(map->handle, LV2_ATOM__Float), &rateFloat_},
        {LV2_OPTIONS_INSTANCE, 0, 0, 0, 0, nullptr},
    };
    g_log.handle = this;
    schedule_ = {this, [](LV2_Worker_Schedule_Handle h, uint32_t size, const void* data) {
                   return static_cast<Lv2Plugin*>(h)->scheduleWork(size, data);
                 }};
    featureList_ = {
        {LV2_URID__map, &urids().mapFeature},
        {LV2_URID__unmap, &urids().unmapFeature},
        {LV2_OPTIONS__options, options_.data()},
        {LV2_BUF_SIZE__boundedBlockLength, nullptr},
        {LV2_WORKER__schedule, &schedule_},
        {LV2_LOG__log, &g_log},
    };
    features_.clear();
    for (auto& f : featureList_) features_.push_back(&f);
    features_.push_back(nullptr);
  }

  void connect() {
    zeros_.assign(maxBlock_, 0.0f);
    scratch_.assign(ports_.size(), std::vector<float>());
    atomIns_.clear();
    atomOuts_.clear();
    for (const auto& p : ports_) {
      const bool main = std::find(mainIns_.begin(), mainIns_.end(), p.index) != mainIns_.end() ||
                        std::find(mainOuts_.begin(), mainOuts_.end(), p.index) != mainOuts_.end();
      if (main) continue;
      if (p.control) {
        lilv_instance_connect_port(instance_, p.index, &controls_[p.index]);
      } else if (p.audio || p.cv) {
        // Sidechains and CV get silence in, a place to write out.
        if (p.input) {
          lilv_instance_connect_port(instance_, p.index, zeros_.data());
        } else {
          scratch_[p.index].assign(maxBlock_, 0.0f);
          lilv_instance_connect_port(instance_, p.index, scratch_[p.index].data());
        }
      } else if (p.atom) {
        auto& list = p.input ? atomIns_ : atomOuts_;
        list.emplace_back(p.index, p.minimumSize);
        list.back().reset(urids().map(LV2_ATOM__Sequence));
        lilv_instance_connect_port(instance_, p.index, list.back().data.data());
      } else {
        lilv_instance_connect_port(instance_, p.index, nullptr);
      }
    }
  }

  // The worker runs at once on the calling thread: harbor-fx is not real time.
  LV2_Worker_Status scheduleWork(uint32_t size, const void* data) {
    if (!worker_) return LV2_WORKER_ERR_UNKNOWN;
    return worker_->work(
        lilv_instance_get_handle(instance_),
        [](LV2_Worker_Respond_Handle h, uint32_t sz, const void* d) {
          auto* me = static_cast<Lv2Plugin*>(h);
          const auto* bytes = static_cast<const uint8_t*>(d);
          me->responses_.emplace_back(bytes, bytes + sz);
          return LV2_WORKER_SUCCESS;
        },
        this, size, data);
  }

  void runWorkerResponses() {
    if (!worker_) return;
    auto responses = std::move(responses_);
    responses_.clear();
    for (const auto& r : responses) {
      if (worker_->work_response) {
        worker_->work_response(lilv_instance_get_handle(instance_), uint32_t(r.size()), r.data());
      }
    }
    if (worker_->end_run) worker_->end_run(lilv_instance_get_handle(instance_));
  }

  const LilvPlugin* plugin_;
  AudioThread& audio_;
  LilvInstance* instance_ = nullptr;
  const LV2_Worker_Interface* worker_ = nullptr;
  const LV2_State_Interface* stateIface_ = nullptr;
  std::vector<PortInfo> ports_;
  std::vector<uint32_t> mainIns_;
  std::vector<uint32_t> mainOuts_;
  std::vector<float> controls_;
  std::map<uint32_t, float> pendingControls_;
  std::mutex controlMutex_;
  std::vector<float> zeros_;
  std::vector<std::vector<float>> scratch_;
  std::vector<AtomBuffer> atomIns_;
  std::vector<AtomBuffer> atomOuts_;
  std::vector<std::vector<uint8_t>> responses_;
  std::vector<uint8_t> pendingState_;
  double rate_ = 0;
  uint32_t maxBlock_ = 4096;
  bool active_ = false;
  int32_t minBlock_ = 1;
  int32_t maxBlockInt_ = 4096;
  int32_t nominalBlock_ = 4096;
  float rateFloat_ = 48000;
  std::vector<LV2_Options_Option> options_;
  LV2_Worker_Schedule schedule_ {};
  std::vector<LV2_Feature> featureList_;
  std::vector<const LV2_Feature*> features_;

  // The plugin's X11 UI while its editor is open.
  std::string uiUri_;
  std::string uiBinary_;
  std::string uiBundle_;
  const LV2UI_Descriptor* uiDesc_ = nullptr;
  const LV2UI_Idle_Interface* uiIdle_ = nullptr;
  LV2UI_Handle ui_ = nullptr;
  EditorFrame* frame_ = nullptr;
  LV2UI_Resize uiResize_ {};
  LV2_Extension_Data_Feature dataAccess_ {};
  std::vector<LV2_Feature> uiFeatureList_;
  std::vector<const LV2_Feature*> uiFeatures_;
  uint32_t uiWidth_ = 640;
  uint32_t uiHeight_ = 400;
  mainloop::Handle uiTimer_ = 0;
  /** Read on the audio thread: the UI's atoms are passed on. */
  std::atomic<bool> uiActive_ {false};
  /** The control values the UI was last told (NaN: not yet). */
  std::vector<float> uiShown_;
  std::mutex uiMutex_;
  std::vector<std::pair<uint32_t, std::vector<uint8_t>>> toPlugin_;
  std::vector<std::pair<uint32_t, std::vector<uint8_t>>> toUi_;
};

} // namespace

std::vector<FxDescriptor> lv2List() {
  std::vector<FxDescriptor> out;
  const LilvPlugins* plugins = lilv_world_get_all_plugins(world().world);
  LILV_FOREACH (plugins, it, plugins) {
    out.push_back(describe(lilv_plugins_get(plugins, it)));
  }
  return out;
}

std::vector<FxDescriptor> lv2Describe(const std::string& uri, std::string& error) {
  const LilvPlugin* p = findPlugin(uri);
  if (!p) {
    error = "No LV2 plugin " + uri;
    return {};
  }
  return {describe(p)};
}

std::unique_ptr<FxPlugin> lv2Load(const std::string& uri, AudioThread& audio, std::string& error) {
  const LilvPlugin* p = findPlugin(uri);
  if (!p) {
    error = "LV2 plugin not installed: " + uri;
    return nullptr;
  }
  if (!isStereo(portsOf(p))) {
    error = "Not a stereo effect (2 in, 2 out)";
    return nullptr;
  }
  return std::make_unique<Lv2Plugin>(p, audio);
}
