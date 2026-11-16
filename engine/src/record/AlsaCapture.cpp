#if defined(__linux__)

#include "CaptureSource.h"

#include <alsa/asoundlib.h>

#include <atomic>
#include <cerrno>
#include <cstdio>
#include <cstring>
#include <vector>

namespace {

/** Capture formats, best first. Only the hw: device's own formats: nothing converts. */
constexpr snd_pcm_format_t kFormats[] = {
  SND_PCM_FORMAT_S32_LE,
  SND_PCM_FORMAT_S24_LE,
  SND_PCM_FORMAT_S24_3LE,
  SND_PCM_FORMAT_S16_LE,
};

class AlsaCapture : public CaptureSource {
public:
  explicit AlsaCapture(std::string device) : device_(std::move(device)) {}
  ~AlsaCapture() override { close(); }

  bool open(uint32_t rate, int channels, std::string& error) override {
    int err = snd_pcm_open(&pcm_, device_.c_str(), SND_PCM_STREAM_CAPTURE, SND_PCM_NONBLOCK);
    if (err < 0) {
      error = "Cannot open " + device_ + ": " + snd_strerror(err);
      pcm_ = nullptr;
      return false;
    }
    snd_pcm_hw_params_t* hw;
    snd_pcm_hw_params_alloca(&hw);
    snd_pcm_hw_params_any(pcm_, hw);
    // No resampling, ever: the rate is the input's or the open fails.
    snd_pcm_hw_params_set_rate_resample(pcm_, hw, 0);
    if ((err = snd_pcm_hw_params_set_access(pcm_, hw, SND_PCM_ACCESS_RW_INTERLEAVED)) < 0) {
      return fail(error, "interleaved access", err);
    }
    format_ = SND_PCM_FORMAT_UNKNOWN;
    for (snd_pcm_format_t f : kFormats) {
      if (snd_pcm_hw_params_test_format(pcm_, hw, f) == 0) {
        format_ = f;
        break;
      }
    }
    if (format_ == SND_PCM_FORMAT_UNKNOWN) return fail(error, "an integer PCM format", -EINVAL);
    if ((err = snd_pcm_hw_params_set_format(pcm_, hw, format_)) < 0) return fail(error, "the format", err);
    if ((err = snd_pcm_hw_params_set_channels(pcm_, hw, unsigned(channels))) < 0) {
      return fail(error, std::to_string(channels) + " channels", err);
    }
    if ((err = snd_pcm_hw_params_set_rate(pcm_, hw, rate, 0)) < 0) {
      return fail(error, std::to_string(rate) + " Hz", err);
    }
    unsigned bufferUs = 500000;
    unsigned periodUs = 50000;
    snd_pcm_hw_params_set_buffer_time_near(pcm_, hw, &bufferUs, nullptr);
    snd_pcm_hw_params_set_period_time_near(pcm_, hw, &periodUs, nullptr);
    if ((err = snd_pcm_hw_params(pcm_, hw)) < 0) return fail(error, "these settings", err);

    unsigned actual = 0;
    int dir = 0;
    snd_pcm_hw_params_get_rate(hw, &actual, &dir);
    if (actual != rate || dir != 0) {
      error = device_ + " runs at " + std::to_string(actual) + " Hz, not " + std::to_string(rate) + " Hz";
      close();
      return false;
    }
    const int sbits = snd_pcm_hw_params_get_sbits(hw);
    const int width = snd_pcm_format_width(format_);
    bits_ = sbits > 0 && sbits <= width ? sbits : width;
    channels_ = channels;
    frameBytes_ = size_t(snd_pcm_format_physical_width(format_) / 8) * size_t(channels);

    snd_pcm_sw_params_t* sw;
    snd_pcm_sw_params_alloca(&sw);
    snd_pcm_sw_params_current(pcm_, sw);
    snd_pcm_uframes_t period = 0;
    snd_pcm_hw_params_get_period_size(hw, &period, &dir);
    snd_pcm_sw_params_set_avail_min(pcm_, sw, period ? period : 1024);
    snd_pcm_sw_params(pcm_, sw);

    if ((err = snd_pcm_prepare(pcm_)) < 0 || (err = snd_pcm_start(pcm_)) < 0) return fail(error, "start", err);
    return true;
  }

  long read(int32_t* out, size_t maxFrames, int timeoutMs) override {
    if (!pcm_) return -1;
    int w = snd_pcm_wait(pcm_, timeoutMs);
    if (w == 0) return 0; // no clock from the input: nothing to read
    if (w < 0) return recover(w);
    buffer_.resize(maxFrames * frameBytes_);
    const snd_pcm_sframes_t got = snd_pcm_readi(pcm_, buffer_.data(), snd_pcm_uframes_t(maxFrames));
    if (got == -EAGAIN) return 0;
    if (got < 0) return recover(int(got));
    convert(out, size_t(got));
    return long(got);
  }

  void close() override {
    if (pcm_) {
      snd_pcm_drop(pcm_);
      snd_pcm_close(pcm_);
      pcm_ = nullptr;
    }
  }

  int deviceBits() const override { return bits_; }
  uint64_t overruns() const override { return overruns_.load(); }
  std::string lastError() const override { return lastError_; }

private:
  bool fail(std::string& error, const std::string& what, int err) {
    error = device_ + " cannot record with " + what + ": " + snd_strerror(err);
    close();
    return false;
  }

  long recover(int err) {
    if (err == -EPIPE) {
      // Overrun: samples were lost. Counted, so the take says it is not bit-perfect.
      ++overruns_;
      if (snd_pcm_prepare(pcm_) == 0 && snd_pcm_start(pcm_) == 0) return 0;
    } else if (err == -ESTRPIPE) {
      int r;
      while ((r = snd_pcm_resume(pcm_)) == -EAGAIN) {
      }
      if (r < 0) snd_pcm_prepare(pcm_);
      snd_pcm_start(pcm_);
      return 0;
    }
    if (snd_pcm_recover(pcm_, err, 1) == 0) {
      snd_pcm_start(pcm_);
      return 0;
    }
    lastError_ = std::string("Capture failed: ") + snd_strerror(err);
    return -1;
  }

  void convert(int32_t* out, size_t frames) {
    const size_t samples = frames * size_t(channels_);
    const uint8_t* p = buffer_.data();
    switch (format_) {
      case SND_PCM_FORMAT_S32_LE:
        std::memcpy(out, p, samples * 4);
        break;
      case SND_PCM_FORMAT_S24_LE: // 24 bits in the low three bytes of four
        for (size_t i = 0; i < samples; ++i, p += 4) {
          out[i] = int32_t((uint32_t(p[0]) << 8) | (uint32_t(p[1]) << 16) | (uint32_t(p[2]) << 24));
        }
        break;
      case SND_PCM_FORMAT_S24_3LE:
        for (size_t i = 0; i < samples; ++i, p += 3) {
          out[i] = int32_t((uint32_t(p[0]) << 8) | (uint32_t(p[1]) << 16) | (uint32_t(p[2]) << 24));
        }
        break;
      default: // S16_LE
        for (size_t i = 0; i < samples; ++i, p += 2) {
          out[i] = int32_t((uint32_t(p[0]) << 16) | (uint32_t(p[1]) << 24));
        }
        break;
    }
  }

  std::string device_;
  snd_pcm_t* pcm_ = nullptr;
  snd_pcm_format_t format_ = SND_PCM_FORMAT_UNKNOWN;
  int bits_ = 0;
  int channels_ = 2;
  size_t frameBytes_ = 0;
  std::vector<uint8_t> buffer_;
  std::atomic<uint64_t> overruns_{0};
  std::string lastError_;
};

} // namespace

std::vector<CaptureDeviceInfo> listCaptureDevices() {
  std::vector<CaptureDeviceInfo> out;
  int card = -1;
  while (snd_card_next(&card) == 0 && card >= 0) {
    char ctlName[32];
    std::snprintf(ctlName, sizeof(ctlName), "hw:%d", card);
    snd_ctl_t* ctl = nullptr;
    if (snd_ctl_open(&ctl, ctlName, 0) < 0) continue;
    snd_ctl_card_info_t* cardInfo;
    snd_ctl_card_info_alloca(&cardInfo);
    if (snd_ctl_card_info(ctl, cardInfo) < 0) {
      snd_ctl_close(ctl);
      continue;
    }
    int dev = -1;
    while (snd_ctl_pcm_next_device(ctl, &dev) == 0 && dev >= 0) {
      snd_pcm_info_t* pcmInfo;
      snd_pcm_info_alloca(&pcmInfo);
      snd_pcm_info_set_device(pcmInfo, unsigned(dev));
      snd_pcm_info_set_subdevice(pcmInfo, 0);
      snd_pcm_info_set_stream(pcmInfo, SND_PCM_STREAM_CAPTURE);
      if (snd_ctl_pcm_info(ctl, pcmInfo) < 0) continue;
      CaptureDeviceInfo info;
      info.id = std::string("hw:CARD=") + snd_ctl_card_info_get_id(cardInfo) + ",DEV=" + std::to_string(dev);
      info.name = std::string(snd_ctl_card_info_get_name(cardInfo)) + " – " + snd_pcm_info_get_name(pcmInfo);
      out.push_back(std::move(info));
    }
    snd_ctl_close(ctl);
  }
  return out;
}

std::unique_ptr<CaptureSource> makeAlsaCapture(const std::string& device) {
  return std::make_unique<AlsaCapture>(device);
}

#endif
