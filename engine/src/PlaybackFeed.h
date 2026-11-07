#pragma once

#include "FrameSource.h"
#include "FxStage.h"

#include <atomic>
#include <cstdint>
#include <memory>
#include <string>
#include <thread>
#include <vector>

/**
 * Opens a FrameSource and decodes it on a worker into a ring a few seconds deep, ahead of the
 * playhead — a track never sits in memory whole (a 10-minute DSD128 file would take ~1.8 GB as
 * DoP words). Positions are absolute frames of the track.
 *
 * The player reports its playhead with consume(); the worker keeps the ring filled up to
 * `capacity` frames past it. A seek() refills from the new position. Reads copy out what is
 * decoded and return fewer frames (or 0) when the worker is not there yet.
 *
 * open() / close() belong to the player and must not overlap reads; seek(), consume() and the
 * reads may come from any thread (the device thread and the plugin rack's worker read at once).
 */
class PlaybackFeed final : public DryPcm {
public:
  PlaybackFeed() = default;
  ~PlaybackFeed() override;
  PlaybackFeed(const PlaybackFeed&) = delete;
  PlaybackFeed& operator=(const PlaybackFeed&) = delete;

  /** Opens `path` and starts decoding from frame 0. */
  bool open(const std::string& path, const FrameSourceOptions& options, std::string& error);
  /** Stops the worker and frees the ring. */
  void close();

  uint32_t sampleRate() const { return sampleRate_; }
  uint16_t channels() const { return channels_; }
  uint64_t frameCount() const { return frameCount_; }
  bool isDop() const { return dop_; }
  /** Where the audio ends: frameCount, or earlier when the file could not be read further. */
  uint64_t endFrame() const { return end_.load(std::memory_order_acquire); }
  /** Ring size in frames. */
  size_t capacity() const { return capacity_; }

  /** Decode from `frame` on; reads return 0 until the worker has started there. */
  void seek(uint64_t frame);
  /** The playhead: frames before `frame` are played and may be overwritten. */
  void consume(uint64_t frame);

  /** Frames decoded and readable from `pos` on (0 while a seek is pending). */
  size_t available(uint64_t pos) const;
  /** Waits up to `timeoutMs` until `frames` frames from `pos` (or all up to the end) are ready. */
  bool waitReady(uint64_t pos, size_t frames, int timeoutMs) const;

  /** PCM, interleaved float. Returns the frames copied. */
  size_t readFloat(uint64_t pos, float* out, size_t frames) const;
  /** DoP words, interleaved. Returns the frames copied. */
  size_t readDop(uint64_t pos, int32_t* out, size_t frames) const;

  size_t readDry(size_t pos, float* out, size_t frames) override { return readFloat(pos, out, frames); }

private:
  void run();
  size_t copy_(uint64_t pos, void* out, size_t frames) const;

  std::unique_ptr<FrameSource> source_;
  std::thread worker_;
  uint32_t sampleRate_ = 44100;
  uint16_t channels_ = 2;
  uint64_t frameCount_ = 0;
  bool dop_ = false;

  /** 4-byte samples: float bits for PCM, DoP words for DoP. Slot of frame f: f % capacity_. */
  std::vector<uint32_t> ring_;
  size_t capacity_ = 0;

  std::atomic<uint64_t> start_ {0};     // the first frame decoded since the last (re)start
  std::atomic<uint64_t> written_ {0};   // frames [start_, written_) are decoded
  std::atomic<uint64_t> consumed_ {0};  // the playhead
  std::atomic<uint64_t> end_ {0};
  std::atomic<uint64_t> seekTo_ {0};
  std::atomic<uint64_t> seekRequest_ {0};
  std::atomic<uint64_t> seekAck_ {0};
  std::atomic<uint64_t> epoch_ {0};     // bumped by the worker on each restart
  std::atomic<bool> stop_ {false};
};
