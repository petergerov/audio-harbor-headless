#include "FxFrameSource.h"

#include "FxClient.h"
#include "FxStage.h"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace {

/** Fed before a jump's position, its output dropped: envelopes and filters settle. */
constexpr double kWarmUpSecs = 0.5;

} // namespace

FxFrameSource::FxFrameSource(std::unique_ptr<FrameSource> dry)
  : dry_(std::move(dry)), block_(dry_->sampleRate() > 96000 ? 4096 : 2048) {
  scratch_.assign(size_t(block_) * dry_->channels(), 0.0f);
}

bool FxFrameSource::shaping() const {
  const uint16_t ch = dry_->channels();
  return (ch == 1 || ch == 2) && FxClient::instance().engaged() && !FxStage::bypassed();
}

bool FxFrameSource::inStep(uint64_t startFrame) const {
  const FxClient& fx = FxClient::instance();
  return running_ && startFrame == outPos_ && fx.generation() == generation_ && fx.preparations() == preparation_;
}

void FxFrameSource::restartAt(uint64_t startFrame) {
  FxClient& fx = FxClient::instance();
  running_ = fx.prepare(dry_->sampleRate(), dry_->channels(), block_);
  generation_ = fx.generation();
  preparation_ = fx.preparations();
  const uint64_t warmUp = std::min<uint64_t>(startFrame, uint64_t(kWarmUpSecs * dry_->sampleRate()));
  feedPos_ = startFrame - warmUp;
  discard_ = warmUp + fx.latency();
  outPos_ = startFrame;
  pendingAt_ = 0;
  pendingLen_ = 0;
}

bool FxFrameSource::renderBlock() {
  const size_t ch = dry_->channels();
  const uint64_t total = dry_->frameCount();
  const size_t real = feedPos_ < total ? dry_->readFloat(feedPos_, size_t(std::min<uint64_t>(block_, total - feedPos_)), scratch_.data()) : 0;
  // Past the end the chain is fed silence, so its latency's worth of tail comes out.
  std::fill(scratch_.begin() + long(real * ch), scratch_.end(), 0.0f);
  if (!FxClient::instance().process(scratch_.data(), block_)) return false;
  feedPos_ += block_;
  const size_t skip = size_t(std::min<uint64_t>(discard_, block_));
  discard_ -= skip;
  pendingAt_ = skip;
  pendingLen_ = block_ - skip;
  return true;
}

size_t FxFrameSource::readFloat(uint64_t startFrame, size_t count, float* out) {
  const uint64_t total = dry_->frameCount();
  if (startFrame >= total) return 0;
  count = size_t(std::min<uint64_t>(count, total - startFrame));
  if (!shaping()) {
    running_ = false;
    return dry_->readFloat(startFrame, count, out);
  }
  if (!inStep(startFrame)) restartAt(startFrame);
  const size_t ch = dry_->channels();
  size_t done = 0;
  while (running_ && done < count) {
    if (pendingLen_ == 0) {
      // harbor-fx is gone: the rest goes out dry, and the next read tries the chain again.
      if (!renderBlock()) running_ = false;
      continue;
    }
    const size_t n = std::min(pendingLen_, count - done);
    std::memcpy(out + done * ch, scratch_.data() + pendingAt_ * ch, n * ch * sizeof(float));
    pendingAt_ += n;
    pendingLen_ -= n;
    done += n;
  }
  outPos_ = startFrame + done;
  if (done < count) done += dry_->readFloat(startFrame + done, count - done, out + done * ch);
  return done;
}

size_t FxFrameSource::readPacked(uint64_t startFrame, size_t count, uint8_t* out) {
  const size_t ch = dry_->channels();
  packed_.resize(count * ch);
  const size_t frames = readFloat(startFrame, count, packed_.data());
  for (size_t i = 0; i < frames * ch; ++i) {
    // Plugins can go past full scale; a WAV cannot.
    const float s = std::clamp(packed_[i], -1.0f, 1.0f);
    const int32_t v = int32_t(std::lrint(double(s) * 8388607.0));
    out[i * 3] = uint8_t(v);
    out[i * 3 + 1] = uint8_t(v >> 8);
    out[i * 3 + 2] = uint8_t(v >> 16);
  }
  return frames;
}
