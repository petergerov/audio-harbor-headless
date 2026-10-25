// harbor-fx — hosts the plugin rack outside the engine, so a plugin that crashes takes only
// this process down. The engine starts it and talks over stdin / stdout (FxProtocol.h).
//
//   harbor-fx                         serve the engine
//   harbor-fx --list                  plugin files on this machine (JSON)
//   harbor-fx --describe <fmt> <path> the plugins in one file, ports checked (JSON)

#include "FxPlugin.h"
#include "FxProtocol.h"

#include <json.hpp>

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <map>
#include <memory>
#include <string>
#include <vector>

#if defined(_WIN32)
#include <fcntl.h>
#include <io.h>
#else
#include <csignal>
#include <unistd.h>
#endif

using json = nlohmann::json;

namespace {

/** The protocol's stdout. fd 1 itself goes to stderr, so a plugin's printf cannot break a frame. */
int g_out = 1;

void takeStdout() {
#if defined(_WIN32)
  _setmode(0, _O_BINARY);
  _setmode(1, _O_BINARY);
  g_out = _dup(1);
  _dup2(2, 1);
#else
  std::signal(SIGPIPE, SIG_IGN);
  g_out = dup(1);
  dup2(2, 1);
#endif
}

void printJson(const json& j) {
  const std::string text = j.dump() + "\n";
  fxproto::writeAll(g_out, text.data(), text.size());
}

json descriptorJson(const FxDescriptor& d) {
  return json {{"format", d.format}, {"path", d.path},       {"id", d.id},
               {"name", d.name},     {"vendor", d.vendor},   {"version", d.version},
               {"features", d.features}, {"stereo", d.stereo}};
}

struct Insert {
  std::string id;
  std::string format;
  std::string path;
  std::string pluginId;
  std::string name;
  bool bypassed = false;
  std::unique_ptr<FxPlugin> plugin;
  std::string error;
  bool active = false;
  /** A bypassed insert keeps the chain's latency with a plain delay. */
  std::vector<float> delay[2];
  size_t delayPos = 0;
};

class Rack {
public:
  fxproto::Status status() const {
    fxproto::Status s;
    // Engaged on loaded units, so the engine prepares the rack: activation needs the rate.
    for (const auto& ins : chain_) {
      if (!ins.plugin) continue;
      s.flags |= fxproto::kEngaged;
      if (!ins.bypassed) s.flags |= fxproto::kProcessing;
      if (ins.active) s.latency += ins.plugin->latency();
    }
    return s;
  }

  void prepare(double rate, uint32_t channels, uint32_t maxBlock) {
    const bool same = rate == rate_ && maxBlock <= maxBlock_;
    rate_ = rate;
    channels_ = channels;
    maxBlock_ = std::max(maxBlock, maxBlock_);
    for (auto& ins : chain_) {
      if (same && ins.active) {
        audio_.run([&] { ins.plugin->reset(); });
        clearDelay(ins);
      } else {
        activate(ins);
      }
    }
    for (auto& b : buf_) b.assign(maxBlock_, 0.0f);
    for (auto& b : tmp_) b.assign(maxBlock_, 0.0f);
  }

  void reset() {
    audio_.run([&] {
      for (auto& ins : chain_) {
        if (ins.active) ins.plugin->reset();
      }
    });
    for (auto& ins : chain_) clearDelay(ins);
  }

  /** In place on interleaved floats. Mono files run through both sides of each plugin. */
  void process(float* data, uint32_t frames) {
    if (channels_ < 1 || channels_ > 2 || !(status().flags & fxproto::kEngaged)) return;
    for (uint32_t done = 0; done < frames;) {
      const uint32_t n = std::min(frames - done, maxBlock_);
      float* block = data + size_t(done) * channels_;
      for (uint32_t i = 0; i < n; ++i) {
        buf_[0][i] = block[i * channels_];
        buf_[1][i] = block[i * channels_ + channels_ - 1];
      }
      audio_.run([&] { runChain(n); });
      for (uint32_t i = 0; i < n; ++i) {
        if (channels_ == 2) {
          block[i * 2] = buf_[0][i];
          block[i * 2 + 1] = buf_[1][i];
        } else {
          block[i] = 0.5f * (buf_[0][i] + buf_[1][i]);
        }
      }
      done += n;
    }
  }

  json setChain(const json& inserts) {
    std::vector<Insert> next;
    json result = json::array();
    for (const auto& j : inserts) {
      Insert ins;
      ins.id = j.value("id", "");
      ins.format = j.value("format", "");
      ins.path = j.value("path", "");
      ins.pluginId = j.value("pluginId", "");
      ins.name = j.value("name", "");
      ins.bypassed = j.value("bypassed", false);
      auto old = std::find_if(chain_.begin(), chain_.end(), [&](const Insert& o) {
        return o.id == ins.id && o.format == ins.format && o.path == ins.path && o.pluginId == ins.pluginId &&
               o.plugin;
      });
      if (old != chain_.end()) {
        // The running unit is the truth; the state the host sends may be older.
        ins.plugin = std::move(old->plugin);
        ins.active = old->active;
        ins.error = old->error;
        ins.delay[0] = std::move(old->delay[0]);
        ins.delay[1] = std::move(old->delay[1]);
      } else {
        load(ins, j.contains("state") && j["state"].is_string() ? j["state"].get<std::string>() : "");
        if (rate_ > 0 && ins.plugin) activate(ins);
      }
      result.push_back(insertJson(ins));
      next.push_back(std::move(ins));
    }
    // Units no longer in the chain go now, on the main thread.
    chain_ = std::move(next);
    return result;
  }

  Insert* find(const std::string& id) {
    for (auto& ins : chain_) {
      if (ins.id == id) return &ins;
    }
    return nullptr;
  }

  json insertJson(const Insert& ins) const {
    json j {{"id", ins.id}, {"loaded", ins.plugin != nullptr}, {"active", ins.active}, {"bypassed", ins.bypassed}};
    j["latency"] = ins.active ? ins.plugin->latency() : 0;
    if (!ins.error.empty()) j["error"] = ins.error;
    return j;
  }

  json inserts() const {
    json out = json::array();
    for (const auto& ins : chain_) out.push_back(insertJson(ins));
    return out;
  }

  /** Callbacks and restarts the plugins asked for since the last message. */
  void idle() {
    for (auto& ins : chain_) {
      if (!ins.plugin) continue;
      ins.plugin->idle();
      if (ins.plugin->wantsRestart() && rate_ > 0) activate(ins);
    }
  }

  AudioThread& audio() { return audio_; }

private:
  void load(Insert& ins, const std::string& state) {
    std::string error;
    if (ins.format == "clap") {
      ins.plugin = clapLoad(ins.path, ins.pluginId, audio_, error);
#if defined(HARBOR_FX_LV2)
    } else if (ins.format == "lv2") {
      ins.plugin = lv2Load(ins.pluginId, audio_, error);
#endif
    } else {
      error = "Unsupported plugin format: " + ins.format;
    }
    if (!ins.plugin) {
      ins.error = error;
      return;
    }
    if (!state.empty()) {
      std::vector<uint8_t> bytes;
      if (!base64Decode(state, bytes) || !ins.plugin->loadState(bytes)) ins.error = "Saved settings not restored";
    }
  }

  void activate(Insert& ins) {
    if (!ins.plugin) return;
    std::string error;
    ins.active = ins.plugin->activate(rate_, maxBlock_, error);
    ins.error = ins.active ? std::string() : error;
    clearDelay(ins);
  }

  void clearDelay(Insert& ins) {
    const size_t n = ins.active ? ins.plugin->latency() : 0;
    for (auto& d : ins.delay) d.assign(n, 0.0f);
    ins.delayPos = 0;
  }

  void runChain(uint32_t n) {
    for (auto& ins : chain_) {
      if (!ins.active) continue;
      if (ins.bypassed) {
        delay(ins, n);
        continue;
      }
      const float* in[2] = {buf_[0].data(), buf_[1].data()};
      float* out[2] = {tmp_[0].data(), tmp_[1].data()};
      ins.plugin->process(in, out, n);
      std::swap(buf_[0], tmp_[0]);
      std::swap(buf_[1], tmp_[1]);
    }
  }

  void delay(Insert& ins, uint32_t n) {
    const size_t len = ins.delay[0].size();
    if (len == 0) return;
    for (uint32_t i = 0; i < n; ++i) {
      for (int c = 0; c < 2; ++c) {
        const float out = ins.delay[c][ins.delayPos];
        ins.delay[c][ins.delayPos] = buf_[c][i];
        buf_[c][i] = out;
      }
      ins.delayPos = (ins.delayPos + 1) % len;
    }
  }

  AudioThread audio_;
  std::vector<Insert> chain_;
  double rate_ = 0;
  uint32_t channels_ = 2;
  uint32_t maxBlock_ = 4096;
  std::vector<float> buf_[2];
  std::vector<float> tmp_[2];
};

json paramJson(const FxParam& p) {
  json j {{"id", p.id},     {"name", p.name}, {"min", p.min},   {"max", p.max},
          {"default", p.def}, {"value", p.value}, {"text", p.text}, {"stepped", p.stepped}};
  if (!p.module.empty()) j["module"] = p.module;
  if (p.isBypass) j["isBypass"] = true;
  if (!p.options.empty()) {
    json options = json::array();
    for (const auto& [value, text] : p.options) options.push_back({{"value", value}, {"text", text}});
    j["options"] = options;
  }
  return j;
}

json control(Rack& rack, const json& req) {
  const std::string cmd = req.value("cmd", "");
  if (cmd == "ping") return {{"ok", true}};
  if (cmd == "setChain") return {{"ok", true}, {"inserts", rack.setChain(req.value("inserts", json::array()))}};
  if (cmd == "inserts") return {{"ok", true}, {"inserts", rack.inserts()}};
  if (cmd == "getStates") {
    json states = json::object();
    for (const auto& ins : rack.inserts()) {
      Insert* i = rack.find(ins["id"]);
      std::vector<uint8_t> bytes;
      if (i && i->plugin && i->plugin->saveState(bytes)) states[i->id] = base64Encode(bytes);
    }
    return {{"ok", true}, {"states", states}};
  }

  Insert* ins = rack.find(req.value("id", ""));
  if (!ins) return {{"ok", false}, {"error", "No such insert"}};
  if (cmd == "setBypass") {
    ins->bypassed = req.value("bypassed", false);
    return {{"ok", true}, {"insert", rack.insertJson(*ins)}};
  }
  if (!ins->plugin) return {{"ok", false}, {"error", ins->error.empty() ? "Plugin not loaded" : ins->error}};
  if (cmd == "params") {
    json params = json::array();
    for (const auto& p : ins->plugin->params()) params.push_back(paramJson(p));
    return {{"ok", true}, {"params", params}};
  }
  if (cmd == "setParam") {
    const std::string param = req.value("param", "");
    double value = req.value("value", 0.0);
    // Typed by the listener: the plugin reads its own units ("-3.5 dB", "1.2 kHz").
    if (req.contains("text") && !ins->plugin->parse(param, req.value("text", ""), value)) {
      return {{"ok", false}, {"error", "The plugin does not read that value"}};
    }
    if (!ins->plugin->setParam(param, value)) return {{"ok", false}, {"error", "No such parameter"}};
    for (const auto& p : ins->plugin->params()) {
      if (p.id == param) return {{"ok", true}, {"param", paramJson(p)}};
    }
    return {{"ok", true}};
  }
  if (cmd == "getState") {
    std::vector<uint8_t> bytes;
    if (!ins->plugin->saveState(bytes)) return {{"ok", false}, {"error", "The plugin keeps no state"}};
    return {{"ok", true}, {"state", base64Encode(bytes)}};
  }
  return {{"ok", false}, {"error", "Unknown command: " + cmd}};
}

void reply(uint8_t type, const fxproto::Status& status, const void* body, size_t bytes) {
  std::vector<uint8_t> head;
  fxproto::putStatus(head, status);
  fxproto::writeFrame(g_out, type, {{head.data(), head.size()}, {body, bytes}});
}

int serve() {
  Rack rack;
  uint8_t type = 0;
  std::vector<uint8_t> body;
  std::vector<uint8_t> audioHead;
  while (fxproto::readFrame(0, type, body)) {
    switch (type) {
      case fxproto::Prepare: {
        if (body.size() < 12) return 2;
        rack.prepare(double(fxproto::getU32(body.data())), fxproto::getU32(body.data() + 4),
                     fxproto::getU32(body.data() + 8));
        reply(fxproto::StatusReply, rack.status(), nullptr, 0);
        break;
      }
      case fxproto::Process: {
        if (body.size() < 4) return 2;
        const uint32_t frames = fxproto::getU32(body.data());
        float* data = reinterpret_cast<float*>(body.data() + 4);
        const size_t floats = (body.size() - 4) / sizeof(float);
        if (frames > 0 && floats >= frames) rack.process(data, uint32_t(std::min<size_t>(frames, floats)));
        audioHead.clear();
        fxproto::putStatus(audioHead, rack.status());
        fxproto::writeFrame(g_out, fxproto::AudioReply,
                            {{audioHead.data(), audioHead.size()}, {body.data(), body.size()}});
        break;
      }
      case fxproto::Reset:
        rack.reset();
        reply(fxproto::StatusReply, rack.status(), nullptr, 0);
        break;
      case fxproto::Control: {
        json out;
        try {
          out = control(rack, json::parse(body.begin(), body.end()));
        } catch (const std::exception& e) {
          out = {{"ok", false}, {"error", e.what()}};
        }
        const std::string text = out.dump();
        reply(fxproto::ControlReply, rack.status(), text.data(), text.size());
        break;
      }
      default:
        return 2;
    }
    rack.idle();
  }
  return 0;
}

} // namespace

int main(int argc, char** argv) {
  takeStdout();
  if (argc >= 2 && !std::strcmp(argv[1], "--list")) {
    json plugins = json::array();
    for (const auto& d : clapList()) plugins.push_back(descriptorJson(d));
#if defined(HARBOR_FX_LV2)
    for (const auto& d : lv2List()) plugins.push_back(descriptorJson(d));
#endif
    printJson({{"plugins", plugins}});
    return 0;
  }
  if (argc >= 4 && !std::strcmp(argv[1], "--describe")) {
    std::string error;
    std::vector<FxDescriptor> found;
    if (!std::strcmp(argv[2], "clap")) found = clapDescribe(argv[3], error);
#if defined(HARBOR_FX_LV2)
    else if (!std::strcmp(argv[2], "lv2")) found = lv2Describe(argv[3], error);
#endif
    else error = std::string("Unsupported plugin format: ") + argv[2];
    json plugins = json::array();
    for (const auto& d : found) plugins.push_back(descriptorJson(d));
    json out {{"plugins", plugins}};
    if (!error.empty()) out["error"] = error;
    printJson(out);
    // Some plugins leave threads behind; do not wait for them.
    std::fflush(nullptr);
    std::_Exit(0);
  }
  return serve();
}
