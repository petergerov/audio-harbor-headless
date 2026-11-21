// Live input spectrum for insert meters (EQ / multiband overlays). Audio thread feeds
// samples; the control thread runs the FFT when meters are asked for.

#pragma once

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <vector>

struct Spectrum {
  static constexpr size_t kFft = 2048;
  static constexpr size_t kBins = 64;
  static constexpr float kMinHz = 20.0f;
  static constexpr float kMaxHz = 20000.0f;
  static constexpr float kFloorDb = -90.0f;

  Spectrum() {
    ring_.assign(kFft, 0.0f);
    hold_.assign(kBins, kFloorDb);
    peaks_.assign(kBins, kFloorDb);
    window_.resize(kFft);
    constexpr float kPi = 3.14159265358979323846f;
    for (size_t i = 0; i < kFft; ++i) {
      window_[i] = 0.5f * (1.0f - std::cos(2.0f * kPi * float(i) / float(kFft - 1)));
    }
  }

  void setRate(double rate) { rate_ = rate > 0 ? rate : 48000.0; }

  /** Mix stereo to mono into the ring (audio thread). */
  void feed(const std::vector<float>* channels, uint32_t n) {
    for (uint32_t i = 0; i < n; ++i) {
      const float s = 0.5f * (channels[0][i] + channels[1][i]);
      ring_[write_ % kFft] = s;
      ++write_;
      ++sinceFft_;
    }
  }

  /** Peak-hold log bins in dBFS; recomputes when enough new samples arrived. */
  std::vector<float> binsDb() {
    if (sinceFft_ >= kFft / 4) {
      analyse();
      for (size_t i = 0; i < kBins; ++i) hold_[i] = std::max(hold_[i], peaks_[i]);
      sinceFft_ = 0;
    }
    // Fall toward the floor in dB space (never multiply negative dB — that rises toward 0).
    constexpr float kPollFall = 0.82f;
    for (float& h : hold_) {
      h = kFloorDb + (h - kFloorDb) * kPollFall;
      if (h < kFloorDb + 0.5f) h = kFloorDb;
    }
    return hold_;
  }

private:
  void analyse() {
    std::vector<float> re(kFft), im(kFft, 0.0f);
    const size_t start = write_ % kFft;
    for (size_t i = 0; i < kFft; ++i) {
      re[i] = ring_[(start + i) % kFft] * window_[i];
    }
    fft(re, im);

    const float binHz = float(rate_ / double(kFft));
    for (size_t b = 0; b < kBins; ++b) {
      const float t0 = float(b) / float(kBins);
      const float t1 = float(b + 1) / float(kBins);
      const float f0 = kMinHz * std::pow(kMaxHz / kMinHz, t0);
      const float f1 = kMinHz * std::pow(kMaxHz / kMinHz, t1);
      const size_t i0 = std::max<size_t>(1, size_t(f0 / binHz));
      const size_t i1 = std::min(kFft / 2 - 1, std::max(i0 + 1, size_t(f1 / binHz)));
      float energy = 0;
      for (size_t i = i0; i < i1; ++i) {
        energy = std::max(energy, re[i] * re[i] + im[i] * im[i]);
      }
      const float amp = 2.0f * std::sqrt(energy) / float(kFft);
      const float db = amp > 1e-9f ? 20.0f * std::log10(amp) : kFloorDb;
      peaks_[b] = std::max(kFloorDb, std::min(0.0f, db));
    }
  }

  /** In-place radix-2 Cooley–Tukey. */
  static void fft(std::vector<float>& re, std::vector<float>& im) {
    const size_t n = re.size();
    for (size_t i = 1, j = 0; i < n; ++i) {
      size_t bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        std::swap(re[i], re[j]);
        std::swap(im[i], im[j]);
      }
    }
    constexpr float kPi = 3.14159265358979323846f;
    for (size_t len = 2; len <= n; len <<= 1) {
      const float ang = -2.0f * kPi / float(len);
      const float wlenRe = std::cos(ang);
      const float wlenIm = std::sin(ang);
      for (size_t i = 0; i < n; i += len) {
        float wRe = 1.0f, wIm = 0.0f;
        for (size_t j = 0; j < len / 2; ++j) {
          const size_t u = i + j;
          const size_t v = i + j + len / 2;
          const float tRe = wRe * re[v] - wIm * im[v];
          const float tIm = wRe * im[v] + wIm * re[v];
          re[v] = re[u] - tRe;
          im[v] = im[u] - tIm;
          re[u] += tRe;
          im[u] += tIm;
          const float nextRe = wRe * wlenRe - wIm * wlenIm;
          wIm = wRe * wlenIm + wIm * wlenRe;
          wRe = nextRe;
        }
      }
    }
  }

  double rate_ = 48000.0;
  std::vector<float> ring_;
  std::vector<float> window_;
  std::vector<float> hold_;
  std::vector<float> peaks_;
  size_t write_ = 0;
  size_t sinceFft_ = 0;
};
