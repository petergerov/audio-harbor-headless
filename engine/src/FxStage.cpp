#include "FxStage.h"

#include "FxClient.h"

#include <algorithm>
#include <chrono>
#include <cstring>

namespace {

std::atomic<bool> g_bypassed {false};
/** Steady-clock ms until which a knob counts as moving (live mode). */
std::atomic<int64_t> g_liveUntilMs {0};

/** How far the worker renders ahead of the playhead; also how late a knob is heard. */
constexpr double kLookaheadSecs = 0.2;
/** While a knob moves: a short lead in small blocks, so the change is heard soon. */
constexpr double kLiveLookaheadSecs = 0.05;
constexpr uint32_t kLiveBlock = 512;
constexpr int64_t kLiveHoldMs = 3000;

int64_t steadyMs() {
  using namespace std::chrono;
  return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}
/** A/B fade. */
constexpr double kFadeSecs = 0.01;

void nap(int ms) {
  std::this_thread::sleep_for(std::chrono::milliseconds(ms));
}

} // namespace

FxStage::~FxStage() {
  detach();
}

void FxStage::setBypassed(bool bypassed) {
  g_bypassed.store(bypassed);
}

bool FxStage::bypassed() {
  return g_bypassed.load();
}

void FxStage::touch() {
  g_liveUntilMs.store(steadyMs() + kLiveHoldMs);
}

bool FxStage::live() {
  return steadyMs() < g_liveUntilMs.load();
}

void FxStage::attach(const float* dry, const std::atomic<size_t>* ready, size_t total, uint32_t rate,
                     uint16_t channels) {
  detach();
  dry_ = dry;
  ready_ = ready;
  total_ = total;
  rate_ = rate ? rate : 44100;
  channels_ = channels;
  block_ = rate_ > 96000 ? 4096 : 2048;
  lookahead_ = std::max<size_t>(size_t(rate_ * kLookaheadSecs), block_);
  capacity_ = lookahead_ + 2 * size_t(block_);
  ring_.assign(capacity_ * channels_, 0.0f);
  scratch_.assign(size_t(block_) * channels_, 0.0f);
  readPos_ = 0;
  writePos_ = 0;
  seekRequest_ = 0;
  seekAck_ = 0;
  wet_ = false;
  gain_ = g_bypassed.load() ? 0.0f : 1.0f;
  stop_ = false;
  worker_ = std::thread([this] { run(); });
}

void FxStage::detach() {
  stop_ = true;
  if (worker_.joinable()) worker_.join();
  dry_ = nullptr;
  ready_ = nullptr;
  total_ = 0;
  wet_ = false;
}

bool FxStage::engaged() const {
  return dry_ && (channels_ == 1 || channels_ == 2) && FxClient::instance().engaged();
}

size_t FxStage::read(size_t pos, float* out, size_t frames) {
  if (!dry_ || pos >= total_) return 0;
  const size_t ch = channels_;
  if (!engaged()) {
    const size_t ready = ready_->load(std::memory_order_acquire);
    if (pos >= ready) return 0;
    const size_t n = std::min(frames, ready - pos);
    std::memcpy(out, dry_ + pos * ch, n * ch * sizeof(float));
    return n;
  }
  if (seekRequest_.load(std::memory_order_acquire) != seekAck_.load(std::memory_order_acquire)) return 0;
  if (!wet_.load(std::memory_order_acquire) || pos != readPos_.load(std::memory_order_relaxed)) {
    seekTo_.store(pos, std::memory_order_relaxed);
    seekRequest_.fetch_add(1, std::memory_order_release);
    return 0;
  }
  const size_t avail = writePos_.load(std::memory_order_acquire) - pos;
  const size_t n = std::min(frames, avail);
  const float target = g_bypassed.load(std::memory_order_relaxed) ? 0.0f : 1.0f;
  const float step = float(1.0 / (kFadeSecs * rate_));
  for (size_t i = 0; i < n; ++i) {
    const float* wet = ring_.data() + ((pos + i) % capacity_) * ch;
    float* o = out + i * ch;
    if (gain_ == 1.0f && target == 1.0f) {
      for (size_t c = 0; c < ch; ++c) o[c] = wet[c];
      continue;
    }
    if (gain_ < target) gain_ = std::min(target, gain_ + step);
    else if (gain_ > target) gain_ = std::max(target, gain_ - step);
    const float* d = dry_ + (pos + i) * ch;
    for (size_t c = 0; c < ch; ++c) o[c] = gain_ * wet[c] + (1.0f - gain_) * d[c];
  }
  readPos_.store(pos + n, std::memory_order_release);
  return n;
}

void FxStage::run() {
  FxClient& fx = FxClient::instance();
  while (!stop_.load()) {
    if (!engaged()) {
      wet_ = false;
      nap(5);
      continue;
    }
    const uint64_t request = seekRequest_.load(std::memory_order_acquire);
    if (request != seekAck_.load(std::memory_order_relaxed)) {
      restartAt(seekTo_.load(std::memory_order_relaxed));
      seekAck_.store(request, std::memory_order_release);
      continue;
    }
    if (!wet_.load()) {
      nap(1);
      continue;
    }
    // harbor-fx restarted, the latency moved, or a network stream prepared the chain: what
    // is in the ring no longer lines up.
    if (fx.generation() != generation_ || fx.preparations() != preparation_) {
      wet_ = false;
      continue;
    }
    // Live: the lead shrinks as the ring plays out, so later moves are heard within ~50 ms.
    const bool liveNow = live();
    const size_t lead = liveNow ? std::max<size_t>(size_t(rate_ * kLiveLookaheadSecs), 2 * kLiveBlock) : lookahead_;
    const size_t written = writePos_.load(std::memory_order_relaxed);
    if (written >= total_ || written - readPos_.load(std::memory_order_acquire) >= lead) {
      nap(liveNow ? 1 : 2);
      continue;
    }
    if (!renderBlock(liveNow ? std::min(kLiveBlock, block_) : block_)) nap(1);
  }
}

void FxStage::restartAt(size_t pos) {
  FxClient& fx = FxClient::instance();
  // Prepare at this track's format; at the same rate it only clears tails.
  dryFallback_ = !fx.prepare(rate_, channels_, block_);
  generation_ = fx.generation();
  preparation_ = fx.preparations();
  latency_ = dryFallback_ ? 0 : fx.latency();
  discard_ = latency_;
  feedPos_ = pos;
  readPos_.store(pos, std::memory_order_relaxed);
  writePos_.store(pos, std::memory_order_release);
  wet_ = true;
}

bool FxStage::renderBlock(uint32_t block) {
  const size_t ch = channels_;
  const size_t ready = ready_->load(std::memory_order_acquire);
  const size_t need = std::min(feedPos_ + block, total_);
  if (ready < need && ready < total_) return false;  // decoder still behind

  const size_t written = writePos_.load(std::memory_order_relaxed);
  size_t produced = 0;
  if (!dryFallback_) {
    const size_t real = feedPos_ < total_ ? std::min<size_t>(block, total_ - feedPos_) : 0;
    std::memcpy(scratch_.data(), dry_ + feedPos_ * ch, real * ch * sizeof(float));
    std::fill(scratch_.begin() + long(real * ch), scratch_.begin() + long(size_t(block) * ch), 0.0f);
    if (FxClient::instance().process(scratch_.data(), block)) {
      const size_t skip = std::min<size_t>(discard_, block);
      discard_ -= uint32_t(skip);
      produced = std::min<size_t>(block - skip, total_ - written);
      for (size_t i = 0; i < produced; ++i) {
        std::memcpy(ring_.data() + ((written + i) % capacity_) * ch, scratch_.data() + (skip + i) * ch,
                    ch * sizeof(float));
      }
      feedPos_ += block;
      writePos_.store(written + produced, std::memory_order_release);
      return true;
    }
    dryFallback_ = true;
  }
  // harbor-fx is gone: the music goes on dry until it is back (a new generation).
  produced = std::min<size_t>(block, total_ - written);
  for (size_t i = 0; i < produced; ++i) {
    std::memcpy(ring_.data() + ((written + i) % capacity_) * ch, dry_ + (written + i) * ch, ch * sizeof(float));
  }
  writePos_.store(written + produced, std::memory_order_release);
  return true;
}
