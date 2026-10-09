#pragma once

#include "FrameSource.h"

#include <atomic>
#include <cstdint>
#include <memory>
#include <string>
#include <thread>
#include <vector>

/**
 * Opens a FrameSource and fills a PCM or DoP buffer on a worker so load() can return
 * after the first quantum. Not thread-safe except for the published readyFrames count.
 */
class PlaybackFeed {
public:
  PlaybackFeed() = default;
  ~PlaybackFeed();
  PlaybackFeed(const PlaybackFeed&) = delete;
  PlaybackFeed& operator=(const PlaybackFeed&) = delete;

  bool open(const std::string& path, const FrameSourceOptions& options, std::string& error);
  void close();

  uint32_t sampleRate() const { return sampleRate_; }
  uint16_t channels() const { return channels_; }
  uint64_t frameCount() const { return frameCount_; }
  bool isDop() const { return dop_; }

  /**
   * Resize `out` to frameCount * channels and fill from frame 0 on a worker.
   * Publishes how many frames are ready; stops early when `cancel` is true.
   */
  void startFloatFill(std::vector<float>& out, std::atomic<size_t>& ready,
                      std::atomic<bool>& cancel);
  void startDopFill(std::vector<int32_t>& out, std::atomic<size_t>& ready,
                    std::atomic<bool>& cancel);

  /** Wait for the worker (if any). */
  void join();

private:
  std::unique_ptr<FrameSource> source_;
  std::thread worker_;
  uint32_t sampleRate_ = 44100;
  uint16_t channels_ = 2;
  uint64_t frameCount_ = 0;
  bool dop_ = false;
};
