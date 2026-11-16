#include "StreamAnalyzer.h"

#include <algorithm>
#include <cmath>

namespace {

/** Valid DoP frames in a row before the stream counts as DoP, and bad ones before it stops. */
constexpr uint32_t kDopEnter = 32;
constexpr uint32_t kDopLeave = 32;
/** A bitstream ends when no sync word came for this many frames (longest burst period: 15360). */
constexpr uint64_t kBurstTimeout = 16384;

inline uint32_t magnitude(int32_t s) { return s < 0 ? uint32_t(-(int64_t(s))) : uint32_t(s); }

int bitsOf(uint32_t mask) {
  if (mask & 0x000000FFu) return 32;
  if (mask & 0x0000FF00u) return 24;
  if (mask) return 16;
  return 0;
}

} // namespace

const char* recordContentName(RecordContent c) {
  switch (c) {
    case RecordContent::Dop: return "dop";
    case RecordContent::Bitstream: return "bitstream";
    default: return "pcm";
  }
}

StreamAnalyzer::StreamAnalyzer(int channels, uint32_t rate, double silenceDb, double silenceSeconds,
                               bool keepBlockMasks)
    : channels_(channels),
      rate_(rate),
      threshold_(uint32_t(std::min(2147483647.0, 2147483648.0 * std::pow(10.0, silenceDb / 20.0)))),
      minSilence_(uint64_t(std::max(0.0, silenceSeconds) * rate)),
      keepMasks_(keepBlockMasks),
      window_(std::max<uint32_t>(1, rate / 100)),
      peaks_(size_t(channels), 0) {}

void StreamAnalyzer::switchTo(RecordContent content, uint64_t at) {
  at = std::max(at, segmentStart_);
  if (at > segmentStart_) segments_.push_back({segmentStart_, at, mode_});
  segmentStart_ = at;
  mode_ = content;
  dopRun_ = 0;
  dopBad_ = 0;
  lastMarker_ = 0;
  haveSync_ = false;
  syncPeriod_ = 0;
  if (content != RecordContent::Pcm) endSilence(at);
}

void StreamAnalyzer::endSilence(uint64_t at) {
  if (inSilence_ && at > silenceStart_ && at - silenceStart_ >= minSilence_ && minSilence_ > 0) {
    silences_.push_back({silenceStart_, at});
  }
  inSilence_ = false;
}

bool StreamAnalyzer::silent() const {
  return mode_ == RecordContent::Pcm && inSilence_ && pos_ - silenceStart_ >= rate_ / 2;
}

void StreamAnalyzer::takePeaks(float* out, int maxChannels) {
  for (int c = 0; c < maxChannels && c < channels_; ++c) {
    out[c] = float(double(peaks_[size_t(c)]) / 2147483648.0);
    peaks_[size_t(c)] = 0;
  }
}

void StreamAnalyzer::feed(const int32_t* x, size_t frames) {
  for (size_t f = 0; f < frames; ++f, ++pos_) {
    const int32_t* s = x + f * size_t(channels_);

    // --- DoP: the same marker on every channel, alternating frame to frame ---
    const uint8_t marker = uint8_t(uint32_t(s[0]) >> 24);
    bool dop = marker == 0x05 || marker == 0xFA;
    for (int c = 1; c < channels_ && dop; ++c) dop = uint8_t(uint32_t(s[c]) >> 24) == marker;
    if (dop && lastMarker_ == marker) dop = false;
    lastMarker_ = dop ? marker : 0;
    if (mode_ == RecordContent::Dop) {
      if (dop) {
        dopBad_ = 0;
      } else if (dopBad_++ == 0) {
        dopBadStart_ = pos_;
      }
      if (dopBad_ >= kDopLeave) switchTo(RecordContent::Pcm, dopBadStart_);
    } else if (mode_ == RecordContent::Pcm) {
      if (dop) {
        if (dopRun_++ == 0) dopRunStart_ = pos_;
        if (dopRun_ >= kDopEnter) switchTo(RecordContent::Dop, dopRunStart_);
      } else {
        dopRun_ = 0;
      }
    }

    // --- IEC 61937: Pa / Pb in the top 16 bits of the left / right word ---
    if (channels_ == 2 && mode_ != RecordContent::Dop) {
      const bool sync = (uint32_t(s[0]) >> 16) == 0xF872u && (uint32_t(s[1]) >> 16) == 0x4E1Fu;
      if (sync) {
        if (haveSync_ && pos_ - lastSync_ <= kBurstTimeout) {
          syncPeriod_ = pos_ - lastSync_;
          if (mode_ == RecordContent::Pcm) switchTo(RecordContent::Bitstream, lastSync_);
        }
        haveSync_ = true;
        lastSync_ = pos_;
      } else if (mode_ == RecordContent::Bitstream && pos_ - lastSync_ > kBurstTimeout) {
        switchTo(RecordContent::Pcm, std::min(pos_, lastSync_ + std::max<uint64_t>(syncPeriod_, 1)));
      }
    }

    // --- Peaks, bits, silence ---
    uint32_t mask = 0;
    uint32_t peak = 0;
    for (int c = 0; c < channels_; ++c) {
      mask |= uint32_t(s[c]);
      const uint32_t m = magnitude(s[c]);
      peak = std::max(peak, m);
      if (m > peaks_[size_t(c)]) peaks_[size_t(c)] = m;
    }
    if (keepMasks_) {
      blockMask_ |= mask;
      if (++blockFill_ == kMaskBlock) {
        blockMasks_.push_back(blockMask_);
        blockMask_ = 0;
        blockFill_ = 0;
      }
    }
    if (mode_ == RecordContent::Pcm) secondMask_ |= mask;
    if (++secondFill_ >= rate_) {
      recentBits_ = mode_ == RecordContent::Pcm ? bitsOf(secondMask_) : 24;
      secondMask_ = 0;
      secondFill_ = 0;
    }
    windowPeak_ = std::max(windowPeak_, peak);
    if (++windowFill_ == window_) {
      const uint64_t windowStart = pos_ + 1 - window_;
      const bool quiet = mode_ == RecordContent::Pcm && windowPeak_ <= threshold_;
      if (quiet && !inSilence_) {
        inSilence_ = true;
        silenceStart_ = std::max(windowStart, segmentStart_);
      } else if (!quiet && inSilence_) {
        endSilence(windowStart);
      }
      windowFill_ = 0;
      windowPeak_ = 0;
    }
  }
}

void StreamAnalyzer::finish() {
  if (keepMasks_ && blockFill_) {
    blockMasks_.push_back(blockMask_);
    blockMask_ = 0;
    blockFill_ = 0;
  }
  if (mode_ == RecordContent::Dop && dopBad_ > 0) {
    // Frames after the last good DoP frame are not DSD.
    switchTo(RecordContent::Pcm, dopBadStart_);
  }
  if (inSilence_) {
    // Silence that runs to the end counts whatever its length (nothing to split after it).
    if (pos_ > silenceStart_) silences_.push_back({silenceStart_, pos_});
    inSilence_ = false;
  }
  if (pos_ > segmentStart_) segments_.push_back({segmentStart_, pos_, mode_});
  segmentStart_ = pos_;
}
