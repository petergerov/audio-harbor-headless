#include <napi.h>
#include <atomic>
#include <memory>
#include <string>
#include <vector>

#include "HarborEngine.h"

namespace {

Napi::ThreadSafeFunction g_tsfn;
std::atomic<bool> g_tsfn_ready { false };

void onEngineEvent(const char* event, const char* json, void*) {
  if (!g_tsfn_ready.load()) return;
  std::string ev(event ? event : "");
  std::string payload(json ? json : "{}");
  g_tsfn.NonBlockingCall([ev, payload](Napi::Env env, Napi::Function jsCallback) {
    jsCallback.Call({
      Napi::String::New(env, ev),
      Napi::String::New(env, payload),
    });
  });
}

HarborOutputMode parseMode(const std::string& m) {
  if (m == "exclusive") return HARBOR_MODE_EXCLUSIVE;
  if (m == "dop") return HARBOR_MODE_DOP;
  return HARBOR_MODE_SHARED;
}

const char* modeToString(HarborOutputMode m) {
  switch (m) {
    case HARBOR_MODE_EXCLUSIVE: return "exclusive";
    case HARBOR_MODE_DOP: return "dop";
    default: return "shared";
  }
}

const char* stateToString(HarborPlaybackState s) {
  switch (s) {
    case HARBOR_STATE_LOADING: return "loading";
    case HARBOR_STATE_PLAYING: return "playing";
    case HARBOR_STATE_PAUSED: return "paused";
    case HARBOR_STATE_FAILED: return "failed";
    default: return "idle";
  }
}

Napi::Object stateToJs(Napi::Env env, const HarborEngineState& s) {
  auto o = Napi::Object::New(env);
  o.Set("state", stateToString(s.state));
  o.Set("positionSecs", s.position_secs);
  if (s.duration_secs >= 0) o.Set("durationSecs", s.duration_secs);
  else o.Set("durationSecs", env.Null());
  o.Set("effectiveMode", modeToString(s.effective_mode));
  if (s.conversion_badge[0]) o.Set("conversionBadge", s.conversion_badge);
  else o.Set("conversionBadge", env.Null());
  if (s.volume >= 0) o.Set("volume", s.volume);
  else o.Set("volume", env.Null());
  if (s.error[0]) o.Set("error", s.error);
  else o.Set("error", env.Null());
  return o;
}

Napi::Value Version(const Napi::CallbackInfo& info) {
  return Napi::String::New(info.Env(), harbor_engine_version());
}

Napi::Value ListDevices(const Napi::CallbackInfo& info) {
  auto env = info.Env();
  HarborDevice devices[64];
  const int n = harbor_engine_list_devices(devices, 64);
  auto arr = Napi::Array::New(env, n);
  for (int i = 0; i < n; ++i) {
    auto o = Napi::Object::New(env);
    o.Set("uid", devices[i].uid);
    o.Set("name", devices[i].name);
    o.Set("isExternal", devices[i].is_external != 0);
    o.Set("supportsExclusive", devices[i].supports_exclusive != 0);
    o.Set("supportsDop", devices[i].supports_dop != 0);
    arr.Set(i, o);
  }
  return arr;
}

Napi::Value SetDevice(const Napi::CallbackInfo& info) {
  if (info.Length() < 1 || info[0].IsNull() || info[0].IsUndefined()) {
    harbor_engine_set_device(nullptr);
  } else {
    std::string uid = info[0].As<Napi::String>();
    harbor_engine_set_device(uid.c_str());
  }
  return info.Env().Undefined();
}

Napi::Value SetOutputMode(const Napi::CallbackInfo& info) {
  std::string mode = info[0].As<Napi::String>();
  harbor_engine_set_output_mode(parseMode(mode));
  return info.Env().Undefined();
}

Napi::Value SetDsdPcmLevel(const Napi::CallbackInfo& info) {
  int db = info[0].As<Napi::Number>().Int32Value();
  harbor_engine_set_dsd_pcm_level(db);
  return info.Env().Undefined();
}

Napi::Value Load(const Napi::CallbackInfo& info) {
  auto env = info.Env();
  std::string path = info[0].As<Napi::String>();
  auto deferred = Napi::Promise::Deferred::New(env);
  if (harbor_engine_load(path.c_str()) == 0) {
    deferred.Resolve(env.Undefined());
  } else {
    deferred.Reject(Napi::Error::New(env, "Failed to load audio file").Value());
  }
  return deferred.Promise();
}

Napi::Value Play(const Napi::CallbackInfo& info) {
  harbor_engine_play();
  return info.Env().Undefined();
}

Napi::Value Pause(const Napi::CallbackInfo& info) {
  harbor_engine_pause();
  return info.Env().Undefined();
}

Napi::Value Stop(const Napi::CallbackInfo& info) {
  harbor_engine_stop();
  return info.Env().Undefined();
}

Napi::Value Seek(const Napi::CallbackInfo& info) {
  harbor_engine_seek(info[0].As<Napi::Number>().DoubleValue());
  return info.Env().Undefined();
}

Napi::Value SetVolume(const Napi::CallbackInfo& info) {
  harbor_engine_set_volume(info[0].As<Napi::Number>().FloatValue());
  return info.Env().Undefined();
}

Napi::Value GetState(const Napi::CallbackInfo& info) {
  HarborEngineState s {};
  harbor_engine_get_state(&s);
  return stateToJs(info.Env(), s);
}

Napi::Value On(const Napi::CallbackInfo& info) {
  // Events are forwarded via the module-level listener set in Init.
  return info.Env().Undefined();
}

Napi::Value SetEventListener(const Napi::CallbackInfo& info) {
  auto env = info.Env();
  if (!info[0].IsFunction()) {
    Napi::TypeError::New(env, "Expected function").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (g_tsfn_ready.exchange(false) && g_tsfn) {
    g_tsfn.Release();
  }
  g_tsfn = Napi::ThreadSafeFunction::New(
    env,
    info[0].As<Napi::Function>(),
    "HarborEngineEvents",
    0,
    1
  );
  g_tsfn_ready = true;
  return env.Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  harbor_engine_init(onEngineEvent, nullptr);

  exports.Set("version", Napi::Function::New(env, Version));
  exports.Set("listDevices", Napi::Function::New(env, ListDevices));
  exports.Set("setDevice", Napi::Function::New(env, SetDevice));
  exports.Set("setOutputMode", Napi::Function::New(env, SetOutputMode));
  exports.Set("setDsdPcmLevel", Napi::Function::New(env, SetDsdPcmLevel));
  exports.Set("load", Napi::Function::New(env, Load));
  exports.Set("play", Napi::Function::New(env, Play));
  exports.Set("pause", Napi::Function::New(env, Pause));
  exports.Set("stop", Napi::Function::New(env, Stop));
  exports.Set("seek", Napi::Function::New(env, Seek));
  exports.Set("setVolume", Napi::Function::New(env, SetVolume));
  exports.Set("getState", Napi::Function::New(env, GetState));
  exports.Set("on", Napi::Function::New(env, On));
  exports.Set("setEventListener", Napi::Function::New(env, SetEventListener));
  return exports;
}

} // namespace

NODE_API_MODULE(harbor_engine, Init)
