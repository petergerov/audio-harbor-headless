#include "FxClient.h"

#include <json.hpp>

#include <chrono>
#include <cstdlib>
#include <cstring>

#if !defined(_WIN32)
#include <dlfcn.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <sys/wait.h>
#include <unistd.h>
extern char** environ;
#endif

using json = nlohmann::json;

namespace {

/** A block that takes longer than this means a hung plugin. */
constexpr int kReplyTimeoutMs = 10000;
constexpr int kMaxCrashes = 3;
constexpr double kCrashWindowSecs = 30;

double nowSecs() {
  using namespace std::chrono;
  return duration<double>(steady_clock::now().time_since_epoch()).count();
}

std::string errorJson(const std::string& message) {
  return json {{"ok", false}, {"error", message}}.dump();
}

#if !defined(_WIN32)
/** readAll with a deadline: a plugin that hangs must not hang playback with it. */
bool readTimed(int fd, void* data, size_t n, int timeoutMs) {
  auto* p = static_cast<uint8_t*>(data);
  while (n > 0) {
    pollfd pfd {fd, POLLIN, 0};
    const int ready = poll(&pfd, 1, timeoutMs);
    if (ready <= 0) return false;
    const ssize_t r = ::read(fd, p, n);
    if (r <= 0) return false;
    p += r;
    n -= size_t(r);
  }
  return true;
}
#endif

} // namespace

FxClient& FxClient::instance() {
  static FxClient client;
  return client;
}

void FxClient::setBinary(const std::string& path) {
  std::lock_guard lock(mutex_);
  binary_ = path;
}

void FxClient::setEventCallback(EventFn fn) {
  std::lock_guard lock(mutex_);
  eventFn_ = std::move(fn);
}

fxproto::Status FxClient::status() const {
  return fxproto::Status {latency_.load(), flags_.load()};
}

std::string FxClient::error() const {
  std::lock_guard lock(mutex_);
  return error_;
}

std::string FxClient::binaryLocked() const {
  if (!binary_.empty()) return binary_;
  if (const char* env = std::getenv("HARBOR_FX")) return env;
#if !defined(_WIN32)
  Dl_info info {};
  if (dladdr(reinterpret_cast<void*>(&FxClient::instance), &info) && info.dli_fname) {
    std::string self = info.dli_fname;
    const size_t slash = self.rfind('/');
    if (slash != std::string::npos) return self.substr(0, slash + 1) + "harbor-fx";
  }
#endif
  return "harbor-fx";
}

std::string FxClient::control(const std::string& request) {
  std::lock_guard lock(mutex_);
  json req;
  try {
    req = json::parse(request);
  } catch (const std::exception& e) {
    return errorJson(std::string("Bad request: ") + e.what());
  }
  const std::string cmd = req.value("cmd", "");
  if (cmd == "setChain") {
    chain_ = request;
    // A new chain is a new chance for a rack that kept crashing.
    givenUp_ = false;
    crashes_ = 0;
    // Nothing to host: no process needed, and playback is plain again.
    if (pid_ == 0 && req.value("inserts", json::array()).empty()) {
      flags_ = 0;
      latency_ = 0;
      error_.clear();
      return json {{"ok", true}, {"inserts", json::array()}}.dump();
    }
  }
  if (!ensureLocked()) return errorJson(error_.empty() ? "Plugin host not running" : error_);
  uint8_t type = 0;
  std::vector<uint8_t> reply;
  if (!roundTripLocked(fxproto::Control, {{request.data(), request.size()}}, type, reply) ||
      type != fxproto::ControlReply) {
    return errorJson(error_.empty() ? "Plugin host stopped" : error_);
  }
  return std::string(reply.begin() + fxproto::kStatusBytes, reply.end());
}

bool FxClient::prepare(uint32_t rate, uint32_t channels, uint32_t maxBlock) {
  std::lock_guard lock(mutex_);
  rate_ = rate;
  channels_ = channels;
  maxBlock_ = maxBlock;
  prepared_ = true;
  ++preparations_;
  if (!ensureLocked()) return false;
  std::vector<uint8_t> body;
  fxproto::putU32(body, rate);
  fxproto::putU32(body, channels);
  fxproto::putU32(body, maxBlock);
  uint8_t type = 0;
  std::vector<uint8_t> reply;
  return roundTripLocked(fxproto::Prepare, {{body.data(), body.size()}}, type, reply);
}

bool FxClient::reset() {
  std::lock_guard lock(mutex_);
  if (!ensureLocked()) return false;
  uint8_t type = 0;
  std::vector<uint8_t> reply;
  return roundTripLocked(fxproto::Reset, {}, type, reply);
}

bool FxClient::process(float* data, uint32_t frames) {
  std::lock_guard lock(mutex_);
  if (!ensureLocked()) return false;
  const size_t bytes = size_t(frames) * channels_ * sizeof(float);
  uint8_t head[4];
  for (int i = 0; i < 4; ++i) head[i] = uint8_t(frames >> (8 * i));
  uint8_t type = 0;
  std::vector<uint8_t> reply;
  if (!roundTripLocked(fxproto::Process, {{head, 4}, {data, bytes}}, type, reply)) return false;
  if (type != fxproto::AudioReply || reply.size() < fxproto::kStatusBytes + 4 + bytes) {
    stopLocked("Plugin host sent a broken block");
    return false;
  }
  std::memcpy(data, reply.data() + fxproto::kStatusBytes + 4, bytes);
  return true;
}

bool FxClient::ensureLocked() {
  if (pid_ != 0) return true;
  if (givenUp_) return false;
  if (!startLocked()) return false;
  // Back to where the engine was: the chain, then the audio format.
  if (!chain_.empty()) {
    uint8_t type = 0;
    std::vector<uint8_t> reply;
    if (!roundTripLocked(fxproto::Control, {{chain_.data(), chain_.size()}}, type, reply)) return false;
  }
  if (prepared_) {
    std::vector<uint8_t> body;
    fxproto::putU32(body, rate_);
    fxproto::putU32(body, channels_);
    fxproto::putU32(body, maxBlock_);
    uint8_t type = 0;
    std::vector<uint8_t> reply;
    if (!roundTripLocked(fxproto::Prepare, {{body.data(), body.size()}}, type, reply)) return false;
  }
  return true;
}

bool FxClient::startLocked() {
#if defined(_WIN32)
  error_ = "The plugin rack is not available on Windows yet";
  return false;
#else
  const std::string bin = binaryLocked();
  if (access(bin.c_str(), X_OK) != 0) {
    error_ = "harbor-fx not found at " + bin;
    givenUp_ = true;
    return false;
  }
  int in[2];
  int out[2];
  if (pipe(in) != 0) return false;
  if (pipe(out) != 0) {
    close(in[0]);
    close(in[1]);
    return false;
  }
  posix_spawn_file_actions_t actions;
  posix_spawn_file_actions_init(&actions);
  posix_spawn_file_actions_adddup2(&actions, in[0], 0);
  posix_spawn_file_actions_adddup2(&actions, out[1], 1);
  posix_spawn_file_actions_addclose(&actions, in[1]);
  posix_spawn_file_actions_addclose(&actions, out[0]);
  char* argv[] = {const_cast<char*>(bin.c_str()), nullptr};
  pid_t pid = 0;
  const int rc = posix_spawn(&pid, bin.c_str(), &actions, nullptr, argv, environ);
  posix_spawn_file_actions_destroy(&actions);
  close(in[0]);
  close(out[1]);
  if (rc != 0) {
    close(in[1]);
    close(out[0]);
    error_ = "Cannot start harbor-fx: " + std::string(std::strerror(rc));
    return false;
  }
  fcntl(in[1], F_SETFD, FD_CLOEXEC);
  fcntl(out[0], F_SETFD, FD_CLOEXEC);
  // A dead harbor-fx must show up as a failed write, not kill the host.
  signal(SIGPIPE, SIG_IGN);
  toChild_ = in[1];
  fromChild_ = out[0];
  pid_ = pid;
  alive_ = true;
  error_.clear();
  ++generation_;
  if (eventFn_) eventFn_("{\"running\":true}");
  return true;
#endif
}

void FxClient::stopLocked(const std::string& why) {
#if !defined(_WIN32)
  if (pid_ != 0) {
    kill(pid_t(pid_), SIGKILL);
    int status = 0;
    waitpid(pid_t(pid_), &status, 0);
  }
  if (toChild_ >= 0) close(toChild_);
  if (fromChild_ >= 0) close(fromChild_);
#endif
  toChild_ = fromChild_ = -1;
  pid_ = 0;
  alive_ = false;
  error_ = why;
  const double now = nowSecs();
  if (crashes_ == 0 || now - firstCrash_ > kCrashWindowSecs) {
    crashes_ = 0;
    firstCrash_ = now;
  }
  if (++crashes_ >= kMaxCrashes) {
    givenUp_ = true;
    flags_ = 0;
    latency_ = 0;
    error_ = why + " — rack stopped; change the rack to try again";
  }
  ++generation_;
  if (eventFn_) {
    const std::string ev = json {{"running", false}, {"error", error_}, {"stopped", givenUp_}}.dump();
    eventFn_(ev.c_str());
  }
}

bool FxClient::roundTripLocked(uint8_t type, const std::vector<std::pair<const void*, size_t>>& parts,
                               uint8_t& replyType, std::vector<uint8_t>& reply) {
#if defined(_WIN32)
  (void)type;
  (void)parts;
  (void)replyType;
  (void)reply;
  return false;
#else
  if (!fxproto::writeFrame(toChild_, type, parts)) {
    stopLocked("Plugin host stopped (a plugin crashed)");
    return false;
  }
  uint8_t head[5];
  if (!readTimed(fromChild_, head, sizeof(head), kReplyTimeoutMs)) {
    stopLocked("Plugin host stopped or hung (a plugin crashed)");
    return false;
  }
  const uint32_t len = fxproto::getU32(head);
  if (len < 1 + fxproto::kStatusBytes || len > fxproto::kMaxFrame) {
    stopLocked("Plugin host sent a broken reply");
    return false;
  }
  replyType = head[4];
  reply.resize(len - 1);
  if (!readTimed(fromChild_, reply.data(), reply.size(), kReplyTimeoutMs)) {
    stopLocked("Plugin host stopped mid-reply");
    return false;
  }
  noteStatus(reply);
  return true;
#endif
}

void FxClient::noteStatus(const std::vector<uint8_t>& reply) {
  const fxproto::Status s = fxproto::getStatus(reply.data());
  if (s.latency != latency_.load()) ++generation_;
  latency_ = s.latency;
  flags_ = s.flags;
}
