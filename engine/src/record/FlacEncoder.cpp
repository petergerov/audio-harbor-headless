#include "FlacEncoder.h"

#include <algorithm>
#include <cstdlib>
#include <cstring>

namespace {

class BitWriter {
public:
  void put(uint64_t value, int n) {
    if (n == 0) return;
    acc_ = (acc_ << n) | (value & ((n == 64 ? 0 : (uint64_t(1) << n)) - 1));
    bits_ += n;
    while (bits_ >= 8) {
      bits_ -= 8;
      buf_.push_back(uint8_t(acc_ >> bits_));
    }
  }
  void putSigned(int64_t value, int n) { put(uint64_t(value), n); }
  void unary(uint64_t zeros) {
    while (zeros >= 32) {
      put(0, 32);
      zeros -= 32;
    }
    put(1, int(zeros) + 1);
  }
  void align() {
    if (bits_) put(0, 8 - bits_);
  }
  std::vector<uint8_t>& bytes() { return buf_; }
  void clear() {
    buf_.clear();
    acc_ = 0;
    bits_ = 0;
  }

private:
  std::vector<uint8_t> buf_;
  uint64_t acc_ = 0;
  int bits_ = 0;
};

uint8_t crc8(const uint8_t* p, size_t n) {
  uint8_t crc = 0;
  for (size_t i = 0; i < n; ++i) {
    crc ^= p[i];
    for (int b = 0; b < 8; ++b) crc = uint8_t((crc & 0x80) ? (crc << 1) ^ 0x07 : crc << 1);
  }
  return crc;
}

uint16_t crc16(const uint8_t* p, size_t n) {
  uint16_t crc = 0;
  for (size_t i = 0; i < n; ++i) {
    crc ^= uint16_t(p[i]) << 8;
    for (int b = 0; b < 8; ++b) crc = uint16_t((crc & 0x8000) ? (crc << 1) ^ 0x8005 : crc << 1);
  }
  return crc;
}

int rateCode(uint32_t rate) {
  switch (rate) {
    case 88200: return 1;
    case 176400: return 2;
    case 192000: return 3;
    case 8000: return 4;
    case 16000: return 5;
    case 22050: return 6;
    case 24000: return 7;
    case 32000: return 8;
    case 44100: return 9;
    case 48000: return 10;
    case 96000: return 11;
    default: return 0; // from STREAMINFO
  }
}

int sizeCode(int bits) {
  switch (bits) {
    case 8: return 1;
    case 12: return 2;
    case 16: return 4;
    case 20: return 5;
    case 24: return 6;
    default: return 0; // from STREAMINFO
  }
}

void putUtf8(BitWriter& w, uint64_t v) {
  if (v < 0x80) {
    w.put(v, 8);
    return;
  }
  int extra;
  if (v < 0x800) extra = 1;
  else if (v < 0x10000) extra = 2;
  else if (v < 0x200000) extra = 3;
  else if (v < 0x4000000) extra = 4;
  else if (v < 0x80000000ull) extra = 5;
  else extra = 6;
  const uint64_t lead = (0xFF00u >> (extra + 1)) & 0xFF; // 110…, 1110…, …, 11111110
  w.put(lead | (v >> (6 * extra)), 8);
  for (int i = extra - 1; i >= 0; --i) w.put(0x80 | ((v >> (6 * i)) & 0x3F), 8);
}

constexpr int kMaxPartitionOrder = 8;

/** How one subframe is coded, and its size in bits (estimated for the Rice part). */
struct SubframePlan {
  enum Kind { Constant, Verbatim, Fixed } kind = Verbatim;
  int order = 0;
  int partitionOrder = 0;
  std::vector<int> params;
  uint64_t bits = 0;
};

inline uint32_t zigzag(int64_t r) { return uint32_t((r << 1) ^ (r >> 63)); }

/** Rice parameter for `n` values summing to `sum` (zig-zagged), and its cost in bits. */
std::pair<int, uint64_t> bestParam(uint64_t sum, uint32_t n, int maxParam) {
  if (n == 0) return {0, 0};
  auto cost = [&](int k) { return uint64_t(n) * (k + 1) + (sum >> k); };
  int k = 0;
  const uint64_t mean = sum / n;
  while (k < maxParam && (uint64_t(1) << (k + 1)) <= mean) ++k;
  int best = k;
  uint64_t bestCost = cost(k);
  for (int c : {k - 1, k + 1}) {
    if (c < 0 || c > maxParam) continue;
    const uint64_t cc = cost(c);
    if (cc < bestCost) {
      best = c;
      bestCost = cc;
    }
  }
  return {best, bestCost};
}

void residuals(const int64_t* x, uint32_t n, int order, std::vector<int64_t>& out) {
  out.resize(n);
  for (uint32_t i = uint32_t(order); i < n; ++i) {
    switch (order) {
      case 0: out[i] = x[i]; break;
      case 1: out[i] = x[i] - x[i - 1]; break;
      case 2: out[i] = x[i] - 2 * x[i - 1] + x[i - 2]; break;
      case 3: out[i] = x[i] - 3 * x[i - 1] + 3 * x[i - 2] - x[i - 3]; break;
      default: out[i] = x[i] - 4 * x[i - 1] + 6 * x[i - 2] - 4 * x[i - 3] + x[i - 4]; break;
    }
  }
}

SubframePlan plan(const int64_t* x, uint32_t n, int bps, std::vector<int64_t>& scratch) {
  SubframePlan p;
  const uint64_t header = 8;
  bool constant = true;
  for (uint32_t i = 1; i < n && constant; ++i) constant = x[i] == x[0];
  if (constant) {
    p.kind = SubframePlan::Constant;
    p.bits = header + uint64_t(bps);
    return p;
  }
  p.kind = SubframePlan::Verbatim;
  p.bits = header + uint64_t(n) * bps;

  // Fixed predictor with the smallest sum of |residual|.
  const int maxOrder = int(std::min<uint32_t>(4, n > 0 ? n - 1 : 0));
  int bestOrder = 0;
  uint64_t bestAbs = UINT64_MAX;
  for (int order = 0; order <= maxOrder; ++order) {
    residuals(x, n, order, scratch);
    uint64_t s = 0;
    for (uint32_t i = uint32_t(order); i < n; ++i) s += uint64_t(scratch[i] < 0 ? -scratch[i] : scratch[i]);
    if (s < bestAbs) {
      bestAbs = s;
      bestOrder = order;
    }
  }
  residuals(x, n, bestOrder, scratch);
  // Residuals must fit 32 bits signed; with ≤ 25-bit input and order ≤ 4 they always do.
  const int maxParam = 30;
  // Sums per partition at the finest order, merged upwards.
  int topOrder = 0;
  while (topOrder < kMaxPartitionOrder && (n % (2u << topOrder)) == 0 && (n >> (topOrder + 1)) > uint32_t(bestOrder)) {
    ++topOrder;
  }
  std::vector<uint64_t> sums(size_t(1) << topOrder, 0);
  const uint32_t finest = n >> topOrder;
  for (size_t part = 0; part < sums.size(); ++part) {
    const uint32_t start = part == 0 ? uint32_t(bestOrder) : uint32_t(part * finest);
    const uint32_t end = uint32_t((part + 1) * finest);
    uint64_t s = 0;
    for (uint32_t i = start; i < end; ++i) s += zigzag(scratch[i]);
    sums[part] = s;
  }
  uint64_t bestRice = UINT64_MAX;
  int bestPartOrder = 0;
  std::vector<int> bestParams;
  std::vector<uint64_t> level = sums;
  for (int po = topOrder; po >= 0; --po) {
    const uint32_t partSize = n >> po;
    uint64_t total = 0;
    std::vector<int> params(level.size());
    bool wide = false;
    for (size_t part = 0; part < level.size(); ++part) {
      const uint32_t count = part == 0 ? partSize - uint32_t(bestOrder) : partSize;
      auto [k, c] = bestParam(level[part], count, maxParam);
      params[part] = k;
      total += c;
      wide = wide || k > 14;
    }
    total += uint64_t(level.size()) * (wide ? 5 : 4);
    if (total < bestRice) {
      bestRice = total;
      bestPartOrder = po;
      bestParams = params;
    }
    if (po > 0) {
      std::vector<uint64_t> up(level.size() / 2);
      for (size_t i = 0; i < up.size(); ++i) up[i] = level[2 * i] + level[2 * i + 1];
      level.swap(up);
    }
  }
  const uint64_t fixedBits = header + uint64_t(bestOrder) * bps + 6 + bestRice;
  if (fixedBits < p.bits) {
    p.kind = SubframePlan::Fixed;
    p.order = bestOrder;
    p.partitionOrder = bestPartOrder;
    p.params = std::move(bestParams);
    p.bits = fixedBits;
  }
  return p;
}

void writeSubframe(BitWriter& w, const int64_t* x, uint32_t n, int bps, const SubframePlan& p,
                   std::vector<int64_t>& scratch) {
  switch (p.kind) {
    case SubframePlan::Constant:
      w.put(0, 8); // 0 pad, type 000000, no wasted bits
      w.putSigned(x[0], bps);
      return;
    case SubframePlan::Verbatim:
      w.put(0x02, 8); // 0, 000001, 0
      for (uint32_t i = 0; i < n; ++i) w.putSigned(x[i], bps);
      return;
    case SubframePlan::Fixed: break;
  }
  w.put(uint64_t(0x08 | p.order) << 1, 8); // 0, 001xxx, 0
  for (int i = 0; i < p.order; ++i) w.putSigned(x[i], bps);
  bool wide = false;
  for (int k : p.params) wide = wide || k > 14;
  w.put(wide ? 1 : 0, 2);
  w.put(uint64_t(p.partitionOrder), 4);
  residuals(x, n, p.order, scratch);
  const uint32_t partSize = n >> p.partitionOrder;
  for (size_t part = 0; part < p.params.size(); ++part) {
    const int k = p.params[part];
    w.put(uint64_t(k), wide ? 5 : 4);
    const uint32_t start = part == 0 ? uint32_t(p.order) : uint32_t(part * partSize);
    const uint32_t end = uint32_t((part + 1) * partSize);
    for (uint32_t i = start; i < end; ++i) {
      const uint32_t u = zigzag(scratch[i]);
      w.unary(u >> k);
      w.put(u, k);
    }
  }
}

void le32(std::vector<uint8_t>& out, uint32_t v) {
  for (int i = 0; i < 4; ++i) out.push_back(uint8_t(v >> (8 * i)));
}

} // namespace

FlacEncoder::~FlacEncoder() {
  if (file_) std::fclose(file_);
}

bool FlacEncoder::open(const std::string& path, uint32_t sampleRate, int channels, int bits,
                       const Tags& tags, std::string& error) {
  if (channels < 1 || channels > 8 || bits < 4 || bits > 24 || sampleRate == 0 || sampleRate > 655350) {
    error = "Unsupported FLAC format";
    return false;
  }
  file_ = std::fopen(path.c_str(), "wb");
  if (!file_) {
    error = "Cannot create " + path;
    return false;
  }
  std::setvbuf(file_, nullptr, _IOFBF, 1 << 20);
  path_ = path;
  rate_ = sampleRate;
  channels_ = channels;
  bits_ = bits;
  tags_ = tags;
  block_.assign(size_t(channels), std::vector<int32_t>(kBlockSize));
  if (!writeHeaderBlocks(false)) {
    error = "Cannot write " + path;
    return false;
  }
  return true;
}

bool FlacEncoder::writeHeaderBlocks(bool final) {
  std::vector<uint8_t> out;
  out.insert(out.end(), {'f', 'L', 'a', 'C'});
  // STREAMINFO
  out.insert(out.end(), {0x00, 0x00, 0x00, 34});
  BitWriter w;
  const uint32_t blockSize = final && totalFrames_ < kBlockSize ? uint32_t(std::max<uint64_t>(totalFrames_, 16)) : kBlockSize;
  w.put(blockSize, 16);
  w.put(blockSize, 16);
  w.put(final ? minFrameBytes_ : 0, 24);
  w.put(final ? maxFrameBytes_ : 0, 24);
  w.put(rate_, 20);
  w.put(uint64_t(channels_ - 1), 3);
  w.put(uint64_t(bits_ - 1), 5);
  w.put(final ? totalFrames_ : 0, 36);
  for (int i = 0; i < 16; ++i) w.put(final ? md5Bytes_[size_t(i)] : 0, 8);
  out.insert(out.end(), w.bytes().begin(), w.bytes().end());
  // VORBIS_COMMENT, then PADDING (last): room to retag (rename) in place later.
  std::vector<uint8_t> vc;
  const std::string vendor = "Audio Harbor";
  le32(vc, uint32_t(vendor.size()));
  vc.insert(vc.end(), vendor.begin(), vendor.end());
  le32(vc, uint32_t(tags_.size()));
  for (const auto& [key, value] : tags_) {
    const std::string entry = key + "=" + value;
    le32(vc, uint32_t(entry.size()));
    vc.insert(vc.end(), entry.begin(), entry.end());
  }
  const uint32_t len = uint32_t(vc.size());
  out.insert(out.end(), {uint8_t(4), uint8_t(len >> 16), uint8_t(len >> 8), uint8_t(len)});
  out.insert(out.end(), vc.begin(), vc.end());
  constexpr uint32_t kPadding = 4096;
  out.insert(out.end(), {uint8_t(0x80 | 1), uint8_t(kPadding >> 16), uint8_t(kPadding >> 8), uint8_t(kPadding)});
  out.insert(out.end(), kPadding, uint8_t(0));
  if (final && std::fseek(file_, 0, SEEK_SET) != 0) return false;
  return std::fwrite(out.data(), 1, out.size(), file_) == out.size();
}

bool FlacEncoder::write(const int32_t* interleaved, size_t frames) {
  if (!file_ || failed_) return false;
  const int bytes = (bits_ + 7) / 8;
  uint8_t le[8 * 4 * 64];
  size_t i = 0;
  while (i < frames) {
    const size_t chunk = std::min<size_t>(frames - i, 64);
    size_t pos = 0;
    for (size_t f = 0; f < chunk; ++f) {
      for (int c = 0; c < channels_; ++c) {
        const int32_t s = interleaved[(i + f) * size_t(channels_) + size_t(c)];
        block_[size_t(c)][fill_ + f] = s;
        for (int b = 0; b < bytes; ++b) le[pos++] = uint8_t(uint32_t(s) >> (8 * b));
      }
    }
    md5_.update(le, pos);
    // chunk never crosses a block boundary: kBlockSize is a multiple of 64.
    fill_ += uint32_t(chunk);
    i += chunk;
    totalFrames_ += chunk;
    if (fill_ == kBlockSize) {
      if (!encodeBlock(kBlockSize)) return false;
      fill_ = 0;
    }
  }
  return true;
}

bool FlacEncoder::encodeBlock(uint32_t n) {
  BitWriter w;
  // Header
  w.put(0xFFF8, 16); // sync, reserved 0, fixed block size
  int bsCode;
  if (n == kBlockSize) bsCode = 12;
  else if (n <= 256) bsCode = 6;
  else bsCode = 7;
  w.put(uint64_t(bsCode), 4);
  w.put(uint64_t(rateCode(rate_)), 4);

  std::vector<int64_t> scratch;
  std::vector<std::vector<int64_t>> ch(static_cast<size_t>(channels_), std::vector<int64_t>(n));
  for (int c = 0; c < channels_; ++c) {
    for (uint32_t i = 0; i < n; ++i) ch[size_t(c)][i] = block_[size_t(c)][i];
  }

  int assignment = channels_ - 1; // independent
  std::vector<SubframePlan> plans;
  std::vector<const std::vector<int64_t>*> sources;
  std::vector<int> bpsOf;
  std::vector<int64_t> mid, side;
  if (channels_ == 2) {
    mid.resize(n);
    side.resize(n);
    for (uint32_t i = 0; i < n; ++i) {
      side[i] = ch[0][i] - ch[1][i];
      mid[i] = (ch[0][i] + ch[1][i]) >> 1;
    }
    const SubframePlan pl = plan(ch[0].data(), n, bits_, scratch);
    const SubframePlan pr = plan(ch[1].data(), n, bits_, scratch);
    const SubframePlan pm = plan(mid.data(), n, bits_, scratch);
    const SubframePlan ps = plan(side.data(), n, bits_ + 1, scratch);
    const uint64_t lr = pl.bits + pr.bits, ls = pl.bits + ps.bits, rs = ps.bits + pr.bits, ms = pm.bits + ps.bits;
    const uint64_t best = std::min({lr, ls, rs, ms});
    if (best == lr) {
      assignment = 1;
      plans = {pl, pr};
      sources = {&ch[0], &ch[1]};
      bpsOf = {bits_, bits_};
    } else if (best == ls) {
      assignment = 8;
      plans = {pl, ps};
      sources = {&ch[0], &side};
      bpsOf = {bits_, bits_ + 1};
    } else if (best == rs) {
      assignment = 9;
      plans = {ps, pr};
      sources = {&side, &ch[1]};
      bpsOf = {bits_ + 1, bits_};
    } else {
      assignment = 10;
      plans = {pm, ps};
      sources = {&mid, &side};
      bpsOf = {bits_, bits_ + 1};
    }
  } else {
    for (int c = 0; c < channels_; ++c) {
      plans.push_back(plan(ch[size_t(c)].data(), n, bits_, scratch));
      sources.push_back(&ch[size_t(c)]);
      bpsOf.push_back(bits_);
    }
  }
  w.put(uint64_t(assignment), 4);
  w.put(uint64_t(sizeCode(bits_)), 3);
  w.put(0, 1);
  putUtf8(w, frameNumber_);
  if (bsCode == 6) w.put(n - 1, 8);
  else if (bsCode == 7) w.put(n - 1, 16);
  w.put(crc8(w.bytes().data(), w.bytes().size()), 8);

  for (size_t c = 0; c < plans.size(); ++c) writeSubframe(w, sources[c]->data(), n, bpsOf[c], plans[c], scratch);
  w.align();
  const uint16_t crc = crc16(w.bytes().data(), w.bytes().size());
  w.put(crc, 16);

  const auto& bytes = w.bytes();
  if (std::fwrite(bytes.data(), 1, bytes.size(), file_) != bytes.size()) {
    failed_ = true;
    return false;
  }
  const uint32_t size = uint32_t(bytes.size());
  minFrameBytes_ = minFrameBytes_ ? std::min(minFrameBytes_, size) : size;
  maxFrameBytes_ = std::max(maxFrameBytes_, size);
  ++frameNumber_;
  return true;
}

bool FlacEncoder::close() {
  if (!file_) return false;
  bool ok = !failed_;
  if (ok && fill_ > 0) ok = encodeBlock(fill_);
  fill_ = 0;
  md5Bytes_.resize(16);
  md5_.finish(md5Bytes_.data());
  if (ok) ok = writeHeaderBlocks(true);
  if (std::fclose(file_) != 0) ok = false;
  file_ = nullptr;
  return ok;
}
