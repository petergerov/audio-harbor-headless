#include "PlaybackFeed.h"

#include <algorithm>

namespace {
constexpr size_t kChunkFrames = 4096;
}

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
    return false;
  }
  source_ = std::move(source);
  return true;
}

void PlaybackFeed::close() {
  if (worker_.joinable()) worker_.join();
  source_.reset();
  sampleRate_ = 44100;
  channels_ = 2;
  frameCount_ = 0;
  dop_ = false;
}

void PlaybackFeed::join() {
  if (worker_.joinable()) worker_.join();
}

void PlaybackFeed::startFloatFill(std::vector<float>& out, std::atomic<size_t>& ready,
                                  std::atomic<bool>& cancel) {
  join();
  if (!source_ || dop_) return;
  const uint16_t ch = channels_;
  const uint64_t total = frameCount_;
  out.assign(size_t(total) * ch, 0.0f);
  ready.store(0, std::memory_order_release);
  auto* source = source_.get();
  worker_ = std::thread([source, &out, &ready, &cancel, ch, total]() {
    uint64_t pos = 0;
    while (pos < total && !cancel.load(std::memory_order_relaxed)) {
      const size_t want = size_t(std::min<uint64_t>(kChunkFrames, total - pos));
      const size_t n = source->readFloat(pos, want, out.data() + size_t(pos) * ch);
      if (n == 0) break;
      pos += n;
      ready.store(size_t(pos), std::memory_order_release);
    }
    ready.store(size_t(pos), std::memory_order_release);
  });
}

void PlaybackFeed::startDopFill(std::vector<int32_t>& out, std::atomic<size_t>& ready,
                                std::atomic<bool>& cancel) {
  join();
  if (!source_ || !dop_) return;
  const uint16_t ch = channels_;
  const uint64_t total = frameCount_;
  out.assign(size_t(total) * ch, 0);
  ready.store(0, std::memory_order_release);
  auto* source = source_.get();
  worker_ = std::thread([source, &out, &ready, &cancel, ch, total]() {
    uint64_t pos = 0;
    while (pos < total && !cancel.load(std::memory_order_relaxed)) {
      const size_t want = size_t(std::min<uint64_t>(kChunkFrames, total - pos));
      const size_t n = source->readDop(pos, want, out.data() + size_t(pos) * ch);
      if (n == 0) break;
      pos += n;
      ready.store(size_t(pos), std::memory_order_release);
    }
    ready.store(size_t(pos), std::memory_order_release);
  });
}
