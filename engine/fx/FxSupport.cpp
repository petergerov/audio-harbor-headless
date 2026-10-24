#include "FxPlugin.h"

AudioThread::AudioThread() {
  thread_ = std::thread([this] {
    std::unique_lock lock(mutex_);
    while (true) {
      cv_.wait(lock, [this] { return job_ != nullptr || quit_; });
      if (quit_) return;
      (*job_)();
      job_ = nullptr;
      done_ = true;
      cv_.notify_all();
    }
  });
}

AudioThread::~AudioThread() {
  {
    std::lock_guard lock(mutex_);
    quit_ = true;
  }
  cv_.notify_all();
  thread_.join();
}

void AudioThread::run(const std::function<void()>& fn) {
  if (isCurrent()) {
    fn();
    return;
  }
  std::unique_lock lock(mutex_);
  job_ = &fn;
  done_ = false;
  cv_.notify_all();
  cv_.wait(lock, [this] { return done_; });
}

namespace {
constexpr char kAlphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

int sextet(char c) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  if (c == '+') return 62;
  if (c == '/') return 63;
  return -1;
}
} // namespace

std::string base64Encode(const std::vector<uint8_t>& data) {
  std::string out;
  out.reserve((data.size() + 2) / 3 * 4);
  for (size_t i = 0; i < data.size(); i += 3) {
    const uint32_t a = data[i];
    const uint32_t b = i + 1 < data.size() ? data[i + 1] : 0;
    const uint32_t c = i + 2 < data.size() ? data[i + 2] : 0;
    const uint32_t v = a << 16 | b << 8 | c;
    out += kAlphabet[v >> 18 & 63];
    out += kAlphabet[v >> 12 & 63];
    out += i + 1 < data.size() ? kAlphabet[v >> 6 & 63] : '=';
    out += i + 2 < data.size() ? kAlphabet[v & 63] : '=';
  }
  return out;
}

bool base64Decode(const std::string& text, std::vector<uint8_t>& out) {
  out.clear();
  uint32_t acc = 0;
  int bits = 0;
  for (char c : text) {
    if (c == '=' || c == '\n' || c == '\r') continue;
    const int v = sextet(c);
    if (v < 0) return false;
    acc = acc << 6 | uint32_t(v);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push_back(uint8_t(acc >> bits));
    }
  }
  return true;
}
