#include "Finalize.h"

#include <algorithm>
#include <cstdio>

#include "DsfWriter.h"
#include "FlacEncoder.h"
#include "RawWav.h"
#include "StreamAnalyzer.h"

namespace {

constexpr size_t kChunk = 1 << 15;

struct Piece {
  uint64_t start;
  uint64_t end;
  RecordContent content;
};

std::string joinPath(const std::string& dir, const std::string& name) {
  if (dir.empty()) return name;
  const char last = dir.back();
  return (last == '/' || last == '\\') ? dir + name : dir + "/" + name;
}

/** OR of every sample in [start, end): block masks inside, the edges read from the file. */
uint32_t rangeMask(WavReader& in, const std::vector<uint32_t>& masks, uint64_t start, uint64_t end,
                   std::vector<int32_t>& buf) {
  const uint64_t B = StreamAnalyzer::kMaskBlock;
  const int ch = in.channels();
  auto direct = [&](uint64_t a, uint64_t b) {
    uint32_t m = 0;
    while (a < b) {
      const size_t want = size_t(std::min<uint64_t>(b - a, kChunk));
      const size_t got = in.read(a, want, buf.data());
      if (!got) break;
      for (size_t i = 0; i < got * size_t(ch); ++i) m |= uint32_t(buf[i]);
      a += got;
    }
    return m;
  };
  const uint64_t firstFull = (start + B - 1) / B;
  const uint64_t endFull = end / B;
  if (endFull <= firstFull + 1) return direct(start, end);
  uint32_t m = direct(start, firstFull * B) | direct(endFull * B, end);
  for (uint64_t b = firstFull; b < endFull && b < masks.size(); ++b) m |= masks[size_t(b)];
  return m;
}

} // namespace

bool finalizeTake(const FinalizeOptions& options, FinalizeResult& result, std::string& error,
                  std::atomic<double>* progress) {
  auto report = [&](double p) {
    if (progress) progress->store(std::min(1.0, std::max(0.0, p)));
  };
  report(0);
  WavReader in;
  if (!in.open(options.rawPath, error)) return false;
  const int ch = in.channels();
  const uint32_t rate = in.sampleRate();
  const uint64_t total = in.frames();
  result.totalFrames = total;
  std::vector<int32_t> buf(kChunk * size_t(ch));

  // Pass 1: what the stream is, where it changes, where it is silent.
  StreamAnalyzer an(ch, rate, options.silenceDb, options.split ? options.silenceSeconds : 0.0, true);
  for (uint64_t pos = 0; pos < total;) {
    const size_t got = in.read(pos, kChunk, buf.data());
    if (!got) break;
    an.feed(buf.data(), got);
    pos += got;
    report(0.3 * double(pos) / double(total));
  }
  an.finish();

  // The pieces: one per segment, PCM cut in the middle of each long silence.
  std::vector<Piece> pieces;
  const auto& silences = an.silences();
  for (const RecordSegment& seg : an.segments()) {
    if (seg.content != RecordContent::Pcm || !options.split) {
      pieces.push_back({seg.start, seg.end, seg.content});
      continue;
    }
    uint64_t from = seg.start;
    for (const SilenceRun& run : silences) {
      if (run.start < seg.start || run.end > seg.end) continue;
      const uint64_t cut = run.start + (run.end - run.start) / 2;
      if (cut > from && cut < seg.end) {
        pieces.push_back({from, cut, RecordContent::Pcm});
        from = cut;
      }
    }
    pieces.push_back({from, seg.end, RecordContent::Pcm});
  }
  auto inSilence = [&](const Piece& p) {
    for (const SilenceRun& run : silences) {
      if (p.start >= run.start && p.end <= run.end) return true;
    }
    return false;
  };

  uint64_t toWrite = 0;
  for (const Piece& p : pieces) toWrite += p.end - p.start;
  uint64_t written = 0;
  int number = 0;

  for (const Piece& piece : pieces) {
    const uint64_t length = piece.end - piece.start;
    uint32_t mask = 0;
    if (piece.content == RecordContent::Pcm) {
      // Nothing worth a file: shorter than 0.1 s, digital silence, or all below the threshold.
      if (length >= rate / 10 && !(options.split && inSilence(piece))) {
        mask = rangeMask(in, an.blockMasks(), piece.start, piece.end, buf);
      }
      if (mask == 0) {
        result.skippedFrames += length;
        written += length;
        continue;
      }
    }
    ++number;
    char num[16];
    std::snprintf(num, sizeof(num), "%02d", number);
    const std::string stem = options.titleBase.empty() ? std::string(num) : options.titleBase + " " + num;
    FinalizedFile file;
    file.sampleRate = rate;
    file.frames = length;
    file.seconds = double(length) / double(rate);

    FlacEncoder flac;
    RawWavWriter wav;
    DsfWriter dsf;
    FILE* raw = nullptr;
    int shift = 0;
    if (piece.content == RecordContent::Pcm) {
      file.bits = (mask & 0xFFu) ? 32 : (mask & 0xFF00u) ? 24 : 16;
      if (file.bits == 32) {
        file.kind = "wav";
        file.path = joinPath(options.outDir, stem + ".wav");
        if (!wav.open(file.path, rate, ch, 32, error)) return false;
      } else {
        file.kind = "flac";
        file.path = joinPath(options.outDir, stem + ".flac");
        shift = 32 - file.bits;
        FlacEncoder::Tags tags = options.tags;
        tags.emplace_back("TITLE", stem);
        tags.emplace_back("TRACKNUMBER", std::to_string(number));
        if (!flac.open(file.path, rate, ch, file.bits, tags, error)) return false;
      }
    } else if (piece.content == RecordContent::Dop) {
      file.kind = "dsf";
      file.bits = 1;
      file.sampleRate = rate * 16;
      file.path = joinPath(options.outDir, stem + ".dsf");
      if (!dsf.open(file.path, rate * 16, ch, error)) return false;
    } else {
      file.kind = "spdif";
      file.bits = 16;
      file.path = joinPath(options.outDir, stem + " bitstream.spdif");
      raw = std::fopen(file.path.c_str(), "wb");
      if (!raw) {
        error = "Cannot create " + file.path;
        return false;
      }
    }

    bool ok = true;
    std::vector<uint8_t> bytes;
    for (uint64_t pos = piece.start; pos < piece.end && ok;) {
      const size_t want = size_t(std::min<uint64_t>(piece.end - pos, kChunk));
      const size_t got = in.read(pos, want, buf.data());
      if (!got) {
        error = "Take ended early while reading";
        ok = false;
        break;
      }
      const size_t samples = got * size_t(ch);
      switch (piece.content) {
        case RecordContent::Pcm:
          if (file.bits == 32) {
            ok = wav.write(buf.data(), got);
          } else {
            for (size_t i = 0; i < samples; ++i) buf[i] >>= shift;
            ok = flac.write(buf.data(), got);
          }
          break;
        case RecordContent::Dop:
          ok = dsf.writeDop(buf.data(), got);
          break;
        case RecordContent::Bitstream:
          bytes.resize(samples * 2);
          for (size_t i = 0; i < samples; ++i) {
            const uint32_t w = uint32_t(buf[i]) >> 16;
            bytes[i * 2] = uint8_t(w);
            bytes[i * 2 + 1] = uint8_t(w >> 8);
          }
          ok = std::fwrite(bytes.data(), 1, bytes.size(), raw) == bytes.size();
          break;
      }
      pos += got;
      written += got;
      report(0.3 + 0.7 * double(written) / double(std::max<uint64_t>(toWrite, 1)));
    }
    bool closed;
    switch (piece.content) {
      case RecordContent::Pcm: closed = file.bits == 32 ? wav.close() : flac.close(); break;
      case RecordContent::Dop: closed = dsf.close(); break;
      default: closed = std::fclose(raw) == 0; break;
    }
    if (!ok || !closed) {
      if (error.empty()) error = "Cannot write " + file.path + " (disk full?)";
      return false;
    }
    result.files.push_back(file);
  }
  report(1);
  return true;
}
