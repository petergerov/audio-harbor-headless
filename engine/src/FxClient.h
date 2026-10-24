#pragma once

#include "../fx/FxProtocol.h"

#include <atomic>
#include <cstdint>
#include <functional>
#include <mutex>
#include <string>

/**
 * The engine's end of harbor-fx: starts it on first use, one request and one reply at a time,
 * and starts it again after a crash with the last chain. A plugin that crashes three times
 * within half a minute stops the rack until the host sends a new chain; playback goes on dry.
 */
class FxClient {
public:
  using EventFn = std::function<void(const char* json)>;

  static FxClient& instance();

  /** Where harbor-fx lives; empty means next to harbor_engine.node (or $HARBOR_FX). */
  void setBinary(const std::string& path);
  void setEventCallback(EventFn fn);

  /** A JSON request; the reply, or {"ok":false,"error":…}. setChain is kept for restarts. */
  std::string control(const std::string& json);
  /** The format of the next audio; plugins are activated at this rate. */
  bool prepare(uint32_t rate, uint32_t channels, uint32_t maxBlock);
  /** Clear tails and delay lines (seek). */
  bool reset();
  /** In place, interleaved. False when harbor-fx is gone: the audio is left untouched. */
  bool process(float* data, uint32_t frames);

  /** Last status harbor-fx reported (also after it is gone). */
  fxproto::Status status() const;
  bool engaged() const { return (flags_.load() & fxproto::kEngaged) != 0; }
  bool processing() const { return (flags_.load() & fxproto::kProcessing) != 0; }
  uint32_t latency() const { return latency_.load(); }
  /** Bumped whenever harbor-fx (re)starts or stops: running audio must start over. */
  uint64_t generation() const { return generation_.load(); }
  bool alive() const { return alive_.load(); }
  /** Why the rack is not running, or empty. */
  std::string error() const;

private:
  FxClient() = default;
  bool ensureLocked();
  bool startLocked();
  void stopLocked(const std::string& why);
  bool roundTripLocked(uint8_t type, const std::vector<std::pair<const void*, size_t>>& parts,
                       uint8_t& replyType, std::vector<uint8_t>& reply);
  void noteStatus(const std::vector<uint8_t>& reply);
  std::string binaryLocked() const;

  mutable std::mutex mutex_;
  std::string binary_;
  EventFn eventFn_;
  std::string chain_;  // last setChain request, replayed after a restart
  std::string error_;
  int toChild_ = -1;
  int fromChild_ = -1;
  long pid_ = 0;
  bool prepared_ = false;
  uint32_t rate_ = 0;
  uint32_t channels_ = 2;
  uint32_t maxBlock_ = 4096;
  int crashes_ = 0;
  double firstCrash_ = 0;
  bool givenUp_ = false;
  std::atomic<uint8_t> flags_ {0};
  std::atomic<uint32_t> latency_ {0};
  std::atomic<uint64_t> generation_ {0};
  std::atomic<bool> alive_ {false};
};
