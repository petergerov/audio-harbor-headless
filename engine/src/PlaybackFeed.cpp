#include "PlaybackFeed.h"

#include <algorithm>
#include <chrono>
#include <cstring>

namespace {
constexpr size_t kChunkFrames = 4096;
/**
 * How far the worker decodes ahead of the playhead. Enough for a USB disk to spin up and for
 * the plugin rack's lead and latency; DSD128 as DoP takes ~23 MB for it.
 */
constexpr double kAheadSecs = 8.0;

void nap(int ms) {
  std::this_thread::sleep_for(std::chrono::milliseconds(ms));
}
} // namespace

PlaybackFeed::~PlaybackFeed() {
  close();
}

bool PlaybackFeed::open(const std::string& path, const FrameSourceOptions& options,
                        std::string& error) {
  close();
  auto source = openFrameSource(path, options, error);
  if (!source) return false;
  sampleRate_ = source->sampleRate();
  channels_ = source->channels();
  frameCount_ = source->frameCount();
  dop_ = source->isDop();
  if (channels_ == 0 || frameCount_ == 0 || sampleRate_ == 0) {
    error = "Nothing to play";
    sampleRate_ = 44100;
    channels_ = 2;
    frameCount_ = 0;
    dop_ = false;
    return false;
  }
  source_ = std::move(source);
  capacity_ = std::max(size_t(double(sampleRate_) * kAheadSecs), 4 * kChunkFrames);
  ring_.assign(capacity_ * channels_, 0);
  start_.store(0);
  written_.store(0);
  consumed_.store(0);
  end_.store(frameCount_, std::memory_order_release);
  seekTo_.store(0);
  seekRequest_.store(0);
  seekAck_.store(0);
  stop_.store(false);
  worker_ = std::thread([this] { run(); });
  return true;
}

void PlaybackFeed::close() {
  stop_.store(true);
  if (worker_.joinable()) worker_.join();
  source_.reset();
  // Give the memory back, not just the size.
  std::vector<uint32_t>().swap(ring_);
  capacity_ = 0;
  sampleRate_ = 44100;
  channels_ = 2;
  frameCount_ = 0;
  dop_ = false;
  start_.store(0);
  written_.store(0);
  consumed_.store(0);
  end_.store(0, std::memory_order_release);
}

void PlaybackFeed::seek(uint64_t frame) {
  if (!source_) return;
  frame = std::min(frame, frameCount_);
  seekTo_.store(frame, std::memory_order_relaxed);
  consumed_.store(frame, std::memory_order_release);
  seekRequest_.fetch_add(1, std::memory_order_acq_rel);
}

void PlaybackFeed::consume(uint64_t frame) {
  // A playhead from before a seek would let the worker run past the new one.
  if (seekRequest_.load(std::memory_order_acquire) != seekAck_.load(std::memory_order_acquire)) return;
  if (frame < start_.load(std::memory_order_acquire) || frame > written_.load(std::memory_order_acquire)) return;
  consumed_.store(frame, std::memory_order_release);
}

size_t PlaybackFeed::available(uint64_t pos) const {
  if (!source_) return 0;
  if (seekRequest_.load(std::memory_order_acquire) != seekAck_.load(std::memory_order_acquire)) return 0;
  const uint64_t start = start_.load(std::memory_order_acquire);
  const uint64_t written = written_.load(std::memory_order_acquire);
  const uint64_t low = std::max(start, consumed_.load(std::memory_order_acquire));
  if (pos < low || pos >= written) return 0;
  return size_t(written - pos);
}

bool PlaybackFeed::waitReady(uint64_t pos, size_t frames, int timeoutMs) const {
  for (int waited = 0;; ++waited) {
    const uint64_t end = endFrame();
    if (pos >= end) return true;
    const size_t want = size_t(std::min<uint64_t>(frames, end - pos));
    if (available(pos) >= want) return true;
    if (waited >= timeoutMs) return false;
    nap(1);
  }
}

size_t PlaybackFeed::readFloat(uint64_t pos, float* out, size_t frames) const {
  return dop_ ? 0 : copy_(pos, out, frames);
}

size_t PlaybackFeed::readDop(uint64_t pos, int32_t* out, size_t frames) const {
  return dop_ ? copy_(pos, out, frames) : 0;
}

size_t PlaybackFeed::copy_(uint64_t pos, void* out, size_t frames) const {
  if (!source_ || frames == 0) return 0;
  const uint64_t request = seekRequest_.load(std::memory_order_acquire);
  if (request != seekAck_.load(std::memory_order_acquire)) return 0;
  const uint64_t epoch = epoch_.load(std::memory_order_acquire);
  const uint64_t start = start_.load(std::memory_order_acquire);
  const uint64_t written = written_.load(std::memory_order_acquire);
  // Frames before the playhead may be overwritten at any moment.
  const uint64_t low = std::max(start, consumed_.load(std::memory_order_acquire));
  if (pos < low || pos >= written) return 0;
  const size_t n = size_t(std::min<uint64_t>(frames, written - pos));
  const size_t ch = channels_;
  const size_t slot = size_t(pos % capacity_);
  const size_t first = std::min(n, capacity_ - slot);
  auto* dst = static_cast<uint8_t*>(out);
  std::memcpy(dst, ring_.data() + slot * ch, first * ch * sizeof(uint32_t));
  if (n > first) {
    std::memcpy(dst + first * ch * sizeof(uint32_t), ring_.data(), (n - first) * ch * sizeof(uint32_t));
  }
  // A restart during the copy: what was copied belongs to the old position.
  if (epoch_.load(std::memory_order_acquire) != epoch ||
      seekRequest_.load(std::memory_order_acquire) != request) {
    return 0;
  }
  return n;
}

void PlaybackFeed::run() {
  FrameSource& source = *source_;
  const size_t ch = channels_;
  const uint64_t total = frameCount_;
  bool stalled = false;  // the source gave nothing: wait for a seek
  while (!stop_.load(std::memory_order_relaxed)) {
    const uint64_t request = seekRequest_.load(std::memory_order_acquire);
    if (request != seekAck_.load(std::memory_order_relaxed)) {
      const uint64_t pos = std::min(seekTo_.load(std::memory_order_relaxed), total);
      start_.store(pos, std::memory_order_release);
      written_.store(pos, std::memory_order_release);
      consumed_.store(pos, std::memory_order_release);
      end_.store(total, std::memory_order_release);
      stalled = false;
      epoch_.fetch_add(1, std::memory_order_acq_rel);
      seekAck_.store(request, std::memory_order_release);
      continue;
    }
    const uint64_t written = written_.load(std::memory_order_relaxed);
    const uint64_t limit = consumed_.load(std::memory_order_acquire) + capacity_;
    if (stalled || written >= total || written >= limit) {
      nap(2);
      continue;
    }
    const size_t slot = size_t(written % capacity_);
    const size_t want = size_t(std::min<uint64_t>(
      {uint64_t(kChunkFrames), total - written, limit - written, uint64_t(capacity_ - slot)}));
    uint32_t* dst = ring_.data() + slot * ch;
    const size_t n = dop_ ? source.readDop(written, want, reinterpret_cast<int32_t*>(dst))
                          : source.readFloat(written, want, reinterpret_cast<float*>(dst));
    if (n == 0) {
      // Unreadable from here: the track ends where the audio does.
      end_.store(written, std::memory_order_release);
      stalled = true;
      continue;
    }
    written_.store(written + n, std::memory_order_release);
  }
}
