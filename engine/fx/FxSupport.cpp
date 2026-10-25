#include "FxPlugin.h"

#include <algorithm>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <system_error>

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

namespace fs = std::filesystem;

std::vector<FxPreset> presetFiles(const std::vector<std::string>& roots, const std::string& extension,
                                  const std::string& group) {
  std::vector<FxPreset> out;
  for (const auto& root : roots) {
    std::error_code ec;
    if (root.empty() || !fs::is_directory(root, ec)) continue;
    for (auto it = fs::recursive_directory_iterator(root, fs::directory_options::skip_permission_denied, ec);
         !ec && it != fs::recursive_directory_iterator(); it.increment(ec)) {
      if (!it->is_regular_file(ec) || it->path().extension() != extension) continue;
      const fs::path folder = it->path().parent_path().lexically_relative(root);
      out.push_back({"file:" + it->path().string(), it->path().stem().string(),
                     folder.empty() || folder == "." ? group : folder.generic_string()});
    }
  }
  std::sort(out.begin(), out.end(), [](const FxPreset& a, const FxPreset& b) {
    return a.group != b.group ? a.group < b.group : a.name < b.name;
  });
  return out;
}

std::string presetFilePath(const std::string& id) {
  return id.rfind("file:", 0) == 0 ? id.substr(5) : std::string();
}

bool readFile(const std::string& path, std::vector<uint8_t>& out) {
  std::ifstream in(path, std::ios::binary);
  if (!in) return false;
  out.assign(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
  return true;
}

std::string homeDir() {
  const char* home = std::getenv("HOME");
  return home ? home : "";
}
