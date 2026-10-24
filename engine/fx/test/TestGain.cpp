// Two tiny CLAP effects for tests, not shipped:
//   harbor.test.gain   one "Gain" parameter in dB (default -6.0206 dB = ×0.5), no latency
//   harbor.test.delay  delays by 64 frames and reports it as latency, so compensation nulls it
#include <clap/clap.h>

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

namespace {

constexpr clap_id kGainId = 1;
constexpr double kDefaultDb = -6.020599913279624;
constexpr uint32_t kDelay = 64;

const char* const kFeatures[] = {CLAP_PLUGIN_FEATURE_AUDIO_EFFECT, CLAP_PLUGIN_FEATURE_UTILITY, nullptr};

const clap_plugin_descriptor kGainDesc = {
    CLAP_VERSION_INIT, "harbor.test.gain", "Harbor Test Gain", "Audio Harbor", "", "", "", "1.0.0", "", kFeatures};
const clap_plugin_descriptor kDelayDesc = {
    CLAP_VERSION_INIT, "harbor.test.delay", "Harbor Test Delay", "Audio Harbor", "", "", "", "1.0.0", "", kFeatures};

struct Plugin {
  clap_plugin plugin;
  const clap_host* host;
  bool isDelay;
  double gainDb = kDefaultDb;
  std::vector<float> line[2];
  size_t pos = 0;
};

Plugin* self(const clap_plugin* p) {
  return static_cast<Plugin*>(p->plugin_data);
}

void applyEvents(Plugin* s, const clap_input_events* in) {
  if (!in) return;
  const uint32_t n = in->size(in);
  for (uint32_t i = 0; i < n; ++i) {
    const clap_event_header* h = in->get(in, i);
    if (h->space_id != CLAP_CORE_EVENT_SPACE_ID || h->type != CLAP_EVENT_PARAM_VALUE) continue;
    const auto* ev = reinterpret_cast<const clap_event_param_value*>(h);
    if (ev->param_id == kGainId) s->gainDb = ev->value;
  }
}

// --- params ---
uint32_t paramsCount(const clap_plugin* p) {
  return self(p)->isDelay ? 0 : 1;
}
bool paramsInfo(const clap_plugin*, uint32_t index, clap_param_info* info) {
  if (index != 0) return false;
  std::memset(info, 0, sizeof(*info));
  info->id = kGainId;
  info->flags = CLAP_PARAM_IS_AUTOMATABLE;
  std::snprintf(info->name, sizeof(info->name), "Gain");
  info->min_value = -60;
  info->max_value = 12;
  info->default_value = kDefaultDb;
  return true;
}
bool paramsValue(const clap_plugin* p, clap_id id, double* value) {
  if (id != kGainId) return false;
  *value = self(p)->gainDb;
  return true;
}
bool paramsText(const clap_plugin*, clap_id id, double value, char* out, uint32_t size) {
  if (id != kGainId) return false;
  std::snprintf(out, size, "%.1f dB", value);
  return true;
}
bool paramsParse(const clap_plugin*, clap_id, const char* text, double* value) {
  *value = std::atof(text);
  return true;
}
void paramsFlush(const clap_plugin* p, const clap_input_events* in, const clap_output_events*) {
  applyEvents(self(p), in);
}
const clap_plugin_params kParams = {paramsCount, paramsInfo, paramsValue, paramsText, paramsParse, paramsFlush};

// --- state: the gain as text ---
bool stateSave(const clap_plugin* p, const clap_ostream* s) {
  char buf[64];
  const int n = std::snprintf(buf, sizeof(buf), "%.17g", self(p)->gainDb);
  return s->write(s, buf, uint64_t(n)) == n;
}
bool stateLoad(const clap_plugin* p, const clap_istream* s) {
  char buf[64] = {};
  const int64_t n = s->read(s, buf, sizeof(buf) - 1);
  if (n <= 0) return false;
  self(p)->gainDb = std::atof(buf);
  return true;
}
const clap_plugin_state kState = {stateSave, stateLoad};

// --- latency, ports ---
uint32_t latencyGet(const clap_plugin* p) {
  return self(p)->isDelay ? kDelay : 0;
}
const clap_plugin_latency kLatency = {latencyGet};

uint32_t portsCount(const clap_plugin*, bool) {
  return 1;
}
bool portsGet(const clap_plugin*, uint32_t index, bool, clap_audio_port_info* info) {
  if (index != 0) return false;
  std::memset(info, 0, sizeof(*info));
  info->id = 0;
  std::snprintf(info->name, sizeof(info->name), "Main");
  info->flags = CLAP_AUDIO_PORT_IS_MAIN;
  info->channel_count = 2;
  info->port_type = CLAP_PORT_STEREO;
  info->in_place_pair = CLAP_INVALID_ID;
  return true;
}
const clap_plugin_audio_ports kPorts = {portsCount, portsGet};

// --- plugin ---
bool init(const clap_plugin*) {
  return true;
}
void destroy(const clap_plugin* p) {
  delete self(p);
}
bool activate(const clap_plugin* p, double, uint32_t, uint32_t) {
  auto* s = self(p);
  for (auto& l : s->line) l.assign(kDelay, 0.0f);
  s->pos = 0;
  return true;
}
void deactivate(const clap_plugin*) {}
bool startProcessing(const clap_plugin*) {
  return true;
}
void stopProcessing(const clap_plugin*) {}
void reset(const clap_plugin* p) {
  auto* s = self(p);
  for (auto& l : s->line) std::fill(l.begin(), l.end(), 0.0f);
  s->pos = 0;
}
clap_process_status process(const clap_plugin* p, const clap_process* proc) {
  auto* s = self(p);
  applyEvents(s, proc->in_events);
  const uint32_t n = proc->frames_count;
  float* const* in = proc->audio_inputs[0].data32;
  float* const* out = proc->audio_outputs[0].data32;
  if (s->isDelay) {
    for (uint32_t i = 0; i < n; ++i) {
      for (int c = 0; c < 2; ++c) {
        const float v = s->line[c][s->pos];
        s->line[c][s->pos] = in[c][i];
        out[c][i] = v;
      }
      s->pos = (s->pos + 1) % kDelay;
    }
  } else {
    const float g = float(std::pow(10.0, s->gainDb / 20.0));
    for (int c = 0; c < 2; ++c) {
      for (uint32_t i = 0; i < n; ++i) out[c][i] = in[c][i] * g;
    }
  }
  return CLAP_PROCESS_CONTINUE;
}
const void* extension(const clap_plugin* p, const char* id) {
  if (!std::strcmp(id, CLAP_EXT_PARAMS)) return self(p)->isDelay ? nullptr : &kParams;
  if (!std::strcmp(id, CLAP_EXT_STATE)) return &kState;
  if (!std::strcmp(id, CLAP_EXT_LATENCY)) return &kLatency;
  if (!std::strcmp(id, CLAP_EXT_AUDIO_PORTS)) return &kPorts;
  return nullptr;
}
void onMainThread(const clap_plugin*) {}

const clap_plugin* create(const clap_host* host, const clap_plugin_descriptor* desc) {
  auto* s = new Plugin();
  s->host = host;
  s->isDelay = desc == &kDelayDesc;
  s->plugin = {desc,           s,       init,    destroy, activate,  deactivate, startProcessing,
               stopProcessing, reset,   process, extension, onMainThread};
  return &s->plugin;
}

// --- factory, entry ---
uint32_t factoryCount(const clap_plugin_factory*) {
  return 2;
}
const clap_plugin_descriptor* factoryDesc(const clap_plugin_factory*, uint32_t index) {
  return index == 0 ? &kGainDesc : index == 1 ? &kDelayDesc : nullptr;
}
const clap_plugin* factoryCreate(const clap_plugin_factory*, const clap_host* host, const char* id) {
  if (!std::strcmp(id, kGainDesc.id)) return create(host, &kGainDesc);
  if (!std::strcmp(id, kDelayDesc.id)) return create(host, &kDelayDesc);
  return nullptr;
}
const clap_plugin_factory kFactory = {factoryCount, factoryDesc, factoryCreate};

bool entryInit(const char*) {
  return true;
}
void entryDeinit() {}
const void* entryFactory(const char* id) {
  return !std::strcmp(id, CLAP_PLUGIN_FACTORY_ID) ? &kFactory : nullptr;
}

} // namespace

extern "C" CLAP_EXPORT const clap_plugin_entry clap_entry = {CLAP_VERSION_INIT, entryInit, entryDeinit,
                                                             entryFactory};
