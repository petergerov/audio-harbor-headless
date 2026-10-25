#pragma once

#include "FrameSource.h"

#include <memory>
#include <vector>

/**
 * A network player's PCM through the plugin rack: the file's frames, processed by the same
 * harbor-fx chain the local stage uses, as 24-bit (plugins may lift a 16-bit file's peaks).
 *
 * Read in order, the chain runs on; a jump (Range request, seek, a second stream taking the
 * chain) prepares it again and feeds half a second before the position, so compressors and
 * filters have settled when the asked-for frame comes out. The latency is compensated as on
 * the local stage. Bypassed, empty or gone, the rack passes the file's frames on untouched.
 */
class FxFrameSource : public FrameSource {
public:
  explicit FxFrameSource(std::unique_ptr<FrameSource> dry);

  uint32_t sampleRate() const override { return dry_->sampleRate(); }
  uint16_t channels() const override { return dry_->channels(); }
  uint64_t frameCount() const override { return dry_->frameCount(); }
  uint16_t bitsPerSample() const override { return 24; }
  size_t readFloat(uint64_t startFrame, size_t count, float* out) override;
  size_t readPacked(uint64_t startFrame, size_t count, uint8_t* out) override;

private:
  bool shaping() const;
  bool inStep(uint64_t startFrame) const;
  void restartAt(uint64_t startFrame);
  bool renderBlock();

  std::unique_ptr<FrameSource> dry_;
  uint32_t block_;
  std::vector<float> scratch_;
  std::vector<float> packed_;

  bool running_ = false;  // the chain was prepared for this stream and has its frames
  uint64_t generation_ = 0;
  uint64_t preparation_ = 0;
  uint64_t feedPos_ = 0;  // next dry frame into the chain
  uint64_t outPos_ = 0;   // the frame pending_[pendingAt_] is
  uint64_t discard_ = 0;  // chain output still to drop: latency and warm-up
  size_t pendingAt_ = 0;
  size_t pendingLen_ = 0;
};
