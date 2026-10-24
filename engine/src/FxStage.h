#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <thread>
#include <vector>

/**
 * The plugin rack between a player's decoded PCM and its device. A worker renders ahead of
 * the playhead through harbor-fx into a ring; the player reads the ring instead of the PCM.
 * With no inserts (FxClient not engaged) read() hands out the PCM untouched.
 *
 * Positions are absolute frames of the track. The plugins' latency is compensated: the first
 * `latency` frames out of the rack after a (re)start are dropped and the tail is fed silence,
 * so ring frame k is the processed dry frame k.
 *
 * read() runs on the device thread and does not lock: one producer (the worker), one
 * consumer (the player). A jump in position (seek) is a request the worker answers.
 */
class FxStage {
public:
  FxStage() = default;
  ~FxStage();
  FxStage(const FxStage&) = delete;
  FxStage& operator=(const FxStage&) = delete;

  /** `dry` holds `total` frames, of which `ready` are decoded; valid until detach(). */
  void attach(const float* dry, const std::atomic<size_t>* ready, size_t total, uint32_t rate, uint16_t channels);
  void detach();

  /** The rack shapes this track: inserts loaded, PCM of one or two channels. */
  bool engaged() const;

  /**
   * Up to `frames` frames from position `pos` into `out`; returns how many. Fewer (or 0)
   * means not ready yet: play silence and ask for the same position again.
   */
  size_t read(size_t pos, float* out, size_t frames);

  /** Whole-rack A/B: the output fades between processed and dry in ~10 ms. */
  static void setBypassed(bool bypassed);
  static bool bypassed();

private:
  void run();
  void restartAt(size_t pos);
  bool renderBlock();

  const float* dry_ = nullptr;
  const std::atomic<size_t>* ready_ = nullptr;
  size_t total_ = 0;
  uint32_t rate_ = 0;
  uint16_t channels_ = 2;

  std::vector<float> ring_;
  size_t capacity_ = 0;  // frames
  size_t lookahead_ = 0;
  uint32_t block_ = 2048;
  std::vector<float> scratch_;

  std::atomic<size_t> readPos_ {0};
  std::atomic<size_t> writePos_ {0};
  std::atomic<uint64_t> seekRequest_ {0};
  std::atomic<uint64_t> seekAck_ {0};
  std::atomic<size_t> seekTo_ {0};
  std::atomic<bool> stop_ {false};
  std::atomic<bool> wet_ {false};  // the ring holds processed audio for readPos_
  std::thread worker_;

  // Worker only.
  size_t feedPos_ = 0;
  uint32_t discard_ = 0;
  uint32_t latency_ = 0;
  uint64_t generation_ = 0;
  bool dryFallback_ = false;

  // Device thread only.
  float gain_ = 1.0f;  // 1 = processed, 0 = dry
};
