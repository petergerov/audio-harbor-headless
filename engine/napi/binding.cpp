#include <napi.h>
#include <atomic>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "HarborEngine.h"
#include "AHDSTDecoder.h"
#include "FrameSource.h"

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

HarborAudioBackend parseBackend(const std::string& s) {
  // Legacy "juce" configs map to native — JUCE was removed.
  if (s == "native" || s == "juce") return HARBOR_BACKEND_NATIVE;
  return HARBOR_BACKEND_AUTO;
}

Napi::Value SetAudioBackend(const Napi::CallbackInfo& info) {
  std::string backend = info[0].As<Napi::String>();
  harbor_engine_set_audio_backend(parseBackend(backend));
  return info.Env().Undefined();
}

Napi::Value GetAudioBackend(const Napi::CallbackInfo& info) {
  auto env = info.Env();
  auto o = Napi::Object::New(env);
  o.Set("requested", harbor_engine_audio_backend_name(harbor_engine_get_requested_audio_backend()));
  o.Set("effective", harbor_engine_audio_backend_name(harbor_engine_get_audio_backend()));
  char list[128] {};
  harbor_engine_list_audio_backends(list, sizeof(list));
  o.Set("available", list);
  return o;
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

struct DstSession {
  AHDSTDecoder* decoder = nullptr;
};

Napi::Value DstBegin(const Napi::CallbackInfo& info) {
  auto env = info.Env();
  if (info.Length() < 2) {
    Napi::TypeError::New(env, "sampleRate, channels required").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const int sr = info[0].As<Napi::Number>().Int32Value();
  const int ch = info[1].As<Napi::Number>().Int32Value();
  AHDSTDecoder* dec = AHDSTDecoderCreate(sr, ch);
  if (!dec) {
    Napi::Error::New(env, "DST decoder create failed").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  auto* session = new DstSession{dec};
  return Napi::External<DstSession>::New(env, session, [](Napi::Env, DstSession* s) {
    if (s->decoder) AHDSTDecoderDestroy(s->decoder);
    delete s;
  });
}

Napi::Value DstDecodeFrame(const Napi::CallbackInfo& info) {
  auto env = info.Env();
  if (info.Length() < 2 || !info[0].IsExternal() || !info[1].IsBuffer()) {
    Napi::TypeError::New(env, "session, frameBuffer required").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  auto* session = info[0].As<Napi::External<DstSession>>().Data();
  if (!session || !session->decoder) {
    Napi::Error::New(env, "invalid DST session").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  auto frame = info[1].As<Napi::Buffer<uint8_t>>();
  const size_t outSize = AHDSTDecoderFrameByteCount(session->decoder);
  auto out = Napi::Buffer<uint8_t>::New(env, outSize);
  const int st = AHDSTDecoderDecode(
    session->decoder, frame.Data(), frame.Length(), out.Data(), outSize);
  if (st == AHDST_ERR_UNSUPPORTED) {
    Napi::Error::New(env, "DST layout unsupported").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (st != AHDST_OK) {
    Napi::Error::New(env, "DST decode failed").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  return out;
}

Napi::Value DstEnd(const Napi::CallbackInfo& info) {
  auto env = info.Env();
  if (info.Length() < 1 || !info[0].IsExternal()) return env.Undefined();
  auto* session = info[0].As<Napi::External<DstSession>>().Data();
  if (session && session->decoder) {
    AHDSTDecoderDestroy(session->decoder);
    session->decoder = nullptr;
  }
  return env.Undefined();
}

// --- Network streams: PCM a network player pulls as WAV, read on the libuv pool ---

struct NetStream {
  std::mutex mutex;
  std::unique_ptr<FrameSource> source;
};

struct NetStreamHolder {
  std::shared_ptr<NetStream> stream;
};

class NetStreamOpenWorker : public Napi::AsyncWorker {
public:
  NetStreamOpenWorker(Napi::Env env, std::string path, FrameSourceOptions options)
    : Napi::AsyncWorker(env),
      deferred_(Napi::Promise::Deferred::New(env)),
      path_(std::move(path)),
      options_(options) {}

  Napi::Promise Promise() { return deferred_.Promise(); }

  void Execute() override {
    std::string error;
    source_ = openFrameSource(path_, options_, error);
    if (!source_) SetError(error.empty() ? "Cannot open audio for streaming" : error);
  }

  void OnOK() override {
    auto env = Env();
    auto stream = std::make_shared<NetStream>();
    stream->source = std::move(source_);
    const FrameSource& s = *stream->source;
    auto info = Napi::Object::New(env);
    info.Set("sampleRate", Napi::Number::New(env, s.sampleRate()));
    info.Set("channels", Napi::Number::New(env, s.channels()));
    info.Set("frameCount", Napi::Number::New(env, double(s.frameCount())));
    info.Set("bitsPerSample", Napi::Number::New(env, s.bitsPerSample()));
    info.Set("handle", Napi::External<NetStreamHolder>::New(
      env, new NetStreamHolder{stream}, [](Napi::Env, NetStreamHolder* holder) { delete holder; }));
    deferred_.Resolve(info);
  }

  void OnError(const Napi::Error& error) override { deferred_.Reject(error.Value()); }

private:
  Napi::Promise::Deferred deferred_;
  std::string path_;
  FrameSourceOptions options_;
  std::unique_ptr<FrameSource> source_;
};

class NetStreamReadWorker : public Napi::AsyncWorker {
public:
  NetStreamReadWorker(Napi::Env env, std::shared_ptr<NetStream> stream, uint64_t start, size_t count)
    : Napi::AsyncWorker(env),
      deferred_(Napi::Promise::Deferred::New(env)),
      stream_(std::move(stream)),
      start_(start),
      count_(count) {}

  Napi::Promise Promise() { return deferred_.Promise(); }

  void Execute() override {
    std::lock_guard<std::mutex> lock(stream_->mutex);
    if (!stream_->source) {
      SetError("Stream closed");
      return;
    }
    FrameSource& s = *stream_->source;
    const size_t blockAlign = size_t(s.channels()) * (s.bitsPerSample() / 8);
    data_.resize(count_ * blockAlign);
    data_.resize(s.readPacked(start_, count_, data_.data()) * blockAlign);
  }

  void OnOK() override {
    deferred_.Resolve(Napi::Buffer<uint8_t>::Copy(Env(), data_.data(), data_.size()));
  }

  void OnError(const Napi::Error& error) override { deferred_.Reject(error.Value()); }

private:
  Napi::Promise::Deferred deferred_;
  std::shared_ptr<NetStream> stream_;
  uint64_t start_;
  size_t count_;
  std::vector<uint8_t> data_;
};

NetStreamHolder* netStreamArg(const Napi::CallbackInfo& info) {
  if (info.Length() < 1 || !info[0].IsExternal()) return nullptr;
  return info[0].As<Napi::External<NetStreamHolder>>().Data();
}

Napi::Value NetStreamOpen(const Napi::CallbackInfo& info) {
  auto env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "path required").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  FrameSourceOptions options;
  if (info.Length() > 1 && info[1].IsObject()) {
    auto o = info[1].As<Napi::Object>();
    if (o.Has("wifi")) options.wifi = o.Get("wifi").ToBoolean().Value();
    if (o.Has("dop")) options.dop = o.Get("dop").ToBoolean().Value();
    if (o.Has("dsdLevel") && o.Get("dsdLevel").IsNumber()) {
      const int db = o.Get("dsdLevel").As<Napi::Number>().Int32Value();
      options.dsdLevelDb = (db == 0 || db == 3 || db == 6) ? db : 3;
    }
  }
  auto* worker = new NetStreamOpenWorker(env, info[0].As<Napi::String>(), options);
  auto promise = worker->Promise();
  worker->Queue();
  return promise;
}

Napi::Value NetStreamRead(const Napi::CallbackInfo& info) {
  auto env = info.Env();
  NetStreamHolder* holder = netStreamArg(info);
  if (!holder || info.Length() < 3 || !info[1].IsNumber() || !info[2].IsNumber()) {
    Napi::TypeError::New(env, "handle, startFrame, frameCount required").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const double start = info[1].As<Napi::Number>().DoubleValue();
  const double count = info[2].As<Napi::Number>().DoubleValue();
  if (!(start >= 0) || !(count >= 0) || count > double(1 << 20)) {
    Napi::RangeError::New(env, "bad frame range").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  auto* worker = new NetStreamReadWorker(env, holder->stream, uint64_t(start), size_t(count));
  auto promise = worker->Promise();
  worker->Queue();
  return promise;
}

Napi::Value NetStreamClose(const Napi::CallbackInfo& info) {
  if (NetStreamHolder* holder = netStreamArg(info)) {
    std::lock_guard<std::mutex> lock(holder->stream->mutex);
    holder->stream->source.reset();
  }
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
  exports.Set("setAudioBackend", Napi::Function::New(env, SetAudioBackend));
  exports.Set("getAudioBackend", Napi::Function::New(env, GetAudioBackend));
  exports.Set("load", Napi::Function::New(env, Load));
  exports.Set("play", Napi::Function::New(env, Play));
  exports.Set("pause", Napi::Function::New(env, Pause));
  exports.Set("stop", Napi::Function::New(env, Stop));
  exports.Set("seek", Napi::Function::New(env, Seek));
  exports.Set("setVolume", Napi::Function::New(env, SetVolume));
  exports.Set("getState", Napi::Function::New(env, GetState));
  exports.Set("on", Napi::Function::New(env, On));
  exports.Set("setEventListener", Napi::Function::New(env, SetEventListener));
  exports.Set("dstBegin", Napi::Function::New(env, DstBegin));
  exports.Set("dstDecodeFrame", Napi::Function::New(env, DstDecodeFrame));
  exports.Set("dstEnd", Napi::Function::New(env, DstEnd));
  exports.Set("netStreamOpen", Napi::Function::New(env, NetStreamOpen));
  exports.Set("netStreamRead", Napi::Function::New(env, NetStreamRead));
  exports.Set("netStreamClose", Napi::Function::New(env, NetStreamClose));
  return exports;
}

} // namespace

NODE_API_MODULE(harbor_engine, Init)
