#include "Recorder.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>

#include "CaptureSource.h"
#include "RawWav.h"
#include "StreamAnalyzer.h"

namespace {

using Clock = std::chrono::steady_clock;

/** Single producer (capture thread), single consumer (writer thread), in samples. */
class Ring {
public:
  explicit Ring(size_t capacity) : data_(capacity) {}
  size_t freeSpace() const { return data_.size() - size_t(head_.load() - tail_.load()); }
  size_t available() const { return size_t(head_.load(std::memory_order_acquire) - tail_.load()); }
  void push(const int32_t* p, size_t n) {
    uint64_t h = head_.load();
    for (size_t i = 0; i < n; ++i) data_[size_t((h + i) % data_.size())] = p[i];
    head_.store(h + n, std::memory_order_release);
  }
  void pop(int32_t* p, size_t n) {
    uint64_t t = tail_.load();
    for (size_t i = 0; i < n; ++i) p[i] = data_[size_t((t + i) % data_.size())];
    tail_.store(t + n, std::memory_order_release);
  }

private:
  std::vector<int32_t> data_;
  std::atomic<uint64_t> head_{0};
  std::atomic<uint64_t> tail_{0};
};

struct Session {
  RecorderStartOptions options;
  std::unique_ptr<CaptureSource> source;
  RawWavWriter raw;
  std::unique_ptr<Ring> ring;
  std::unique_ptr<StreamAnalyzer> analyzer;
  std::atomic<bool> running{true};
  std::atomic<bool> writerDone{false};
  std::atomic<uint64_t> dropped{0};
  std::atomic<int64_t> lastDataMs{0};
  std::thread capture;
  std::thread writer;
  Clock::time_point started = Clock::now();

  std::mutex statusMutex;
  RecorderStatus status;
  float peaks[8] = {};

  int64_t nowMs() const {
    return std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - started).count();
  }
};

std::mutex g_mutex;
std::unique_ptr<Session> g_session;

void setError(Session& s, const std::string& error, bool failed) {
  std::lock_guard<std::mutex> lock(s.statusMutex);
  s.status.error = error;
  if (failed) s.status.failed = true;
}

void captureLoop(Session* s) {
  const int ch = s->options.channels;
  const size_t period = std::max<size_t>(256, s->options.rate / 20);
  std::vector<int32_t> buf(period * size_t(ch));
  while (s->running.load()) {
    const long n = s->source->read(buf.data(), period, 200);
    if (n > 0) {
      s->lastDataMs.store(s->nowMs());
      size_t frames = size_t(n);
      const size_t room = s->ring->freeSpace() / size_t(ch);
      if (frames > room) {
        s->dropped += frames - room;
        frames = room;
      }
      s->ring->push(buf.data(), frames * size_t(ch));
      continue;
    }
    if (n == 0) continue;
    // The device failed (unplugged, driver error): keep trying to get it back.
    setError(*s, s->source->lastError().empty() ? "Input failed" : s->source->lastError(), false);
    s->source->close();
    while (s->running.load()) {
      std::this_thread::sleep_for(std::chrono::milliseconds(500));
      std::string error;
      if (s->source->open(s->options.rate, ch, error)) {
        setError(*s, "", false);
        break;
      }
      setError(*s, error, false);
    }
  }
}

void writerLoop(Session* s) {
  const int ch = s->options.channels;
  const size_t chunk = 8192;
  std::vector<int32_t> buf(chunk * size_t(ch));
  auto lastSync = Clock::now();
  for (;;) {
    const size_t frames = std::min(chunk, s->ring->available() / size_t(ch));
    if (frames == 0) {
      if (!s->running.load()) break;
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
      continue;
    }
    s->ring->pop(buf.data(), frames * size_t(ch));
    s->analyzer->feed(buf.data(), frames);
    if (!s->raw.write(buf.data(), frames)) {
      setError(*s, "Cannot write the recording (disk full?)", true);
      s->running.store(false);
      break;
    }
    if (Clock::now() - lastSync > std::chrono::seconds(5)) {
      s->raw.sync();
      lastSync = Clock::now();
    }
    float peaks[8] = {};
    s->analyzer->takePeaks(peaks, 8);
    std::lock_guard<std::mutex> lock(s->statusMutex);
    for (int c = 0; c < 8; ++c) s->peaks[c] = std::max(s->peaks[c], peaks[c]);
    s->status.frames = s->analyzer->frames();
    s->status.content = recordContentName(s->analyzer->current());
    s->status.bits = s->analyzer->recentBits();
    s->status.silent = s->analyzer->silent();
  }
  if (!s->raw.close()) {
    std::lock_guard<std::mutex> lock(s->statusMutex);
    if (!s->status.failed) {
      s->status.error = "Cannot finish the recording file";
      s->status.failed = true;
    }
  }
  s->writerDone.store(true);
}

RecorderStatus snapshot(Session& s) {
  RecorderStatus st;
  {
    std::lock_guard<std::mutex> lock(s.statusMutex);
    st = s.status;
    std::copy(std::begin(s.peaks), std::end(s.peaks), st.peaks);
    std::fill(std::begin(s.peaks), std::end(s.peaks), 0.0f);
  }
  st.active = !s.writerDone.load();
  st.overruns = s.source ? s.source->overruns() : 0;
  st.dropped = s.dropped.load();
  st.signal = s.lastDataMs.load() > 0 && s.nowMs() - s.lastDataMs.load() < 1000;
  if (!st.signal) st.silent = false;
  return st;
}

} // namespace

bool recorderStart(const RecorderStartOptions& options, std::string& error) {
  std::lock_guard<std::mutex> lock(g_mutex);
  if (g_session && !g_session->writerDone.load()) {
    error = "A recording is already running";
    return false;
  }
  if (g_session) {
    g_session->running.store(false);
    if (g_session->capture.joinable()) g_session->capture.join();
    if (g_session->writer.joinable()) g_session->writer.join();
    g_session.reset();
  }
  if (options.channels < 1 || options.channels > 8 || options.rate < 8000 || options.rate > 768000) {
    error = "Unsupported recording format";
    return false;
  }
  auto s = std::make_unique<Session>();
  s->options = options;
  s->source = makeCaptureSource(options.device);
  if (!s->source) {
    error = "Recording needs an ALSA input (Linux)";
    return false;
  }
  if (!s->source->open(options.rate, options.channels, error)) return false;
  if (!s->raw.open(options.rawPath, options.rate, options.channels, s->source->deviceBits(), error)) {
    s->source->close();
    return false;
  }
  // 8 s of buffer between the input and the disk.
  s->ring = std::make_unique<Ring>(size_t(options.rate) * size_t(options.channels) * 8);
  s->analyzer = std::make_unique<StreamAnalyzer>(options.channels, options.rate, options.silenceDb, 0.0, false);
  s->status.device = options.device;
  s->status.rate = options.rate;
  s->status.channels = options.channels;
  s->status.deviceBits = s->source->deviceBits();
  Session* raw = s.get();
  s->writer = std::thread(writerLoop, raw);
  s->capture = std::thread(captureLoop, raw);
  g_session = std::move(s);
  return true;
}

RecorderStatus recorderStop() {
  std::lock_guard<std::mutex> lock(g_mutex);
  if (!g_session) return {};
  Session& s = *g_session;
  s.running.store(false);
  if (s.capture.joinable()) s.capture.join();
  if (s.writer.joinable()) s.writer.join();
  s.source->close();
  RecorderStatus st = snapshot(s);
  st.active = false;
  g_session.reset();
  return st;
}

RecorderStatus recorderStatus() {
  std::lock_guard<std::mutex> lock(g_mutex);
  if (!g_session) return {};
  return snapshot(*g_session);
}
