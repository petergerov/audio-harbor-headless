#pragma once

#include <cstddef>
#include <cstdint>
#include <string>

struct RecorderStartOptions {
  /** ALSA device (hw:…), or file:/filefast: for tests. */
  std::string device;
  uint32_t rate = 44100;
  int channels = 2;
  /** The raw take (32-bit WAV), finished later by finalizeTake. */
  std::string rawPath;
  /** For the live "silent" flag. */
  double silenceDb = -70.0;
};

struct RecorderStatus {
  bool active = false;
  std::string device;
  uint32_t rate = 0;
  int channels = 0;
  /** Bits the device delivers per sample. */
  int deviceBits = 0;
  uint64_t frames = 0;
  /** Device buffer overruns, and frames lost because the disk fell behind. Both 0 = bit-perfect. */
  uint64_t overruns = 0;
  uint64_t dropped = 0;
  /** Data came in during the last second. */
  bool signal = false;
  /** pcm | dop | bitstream */
  std::string content = "pcm";
  /** Bits the PCM used in the last second (0 = digital silence). */
  int bits = 0;
  bool silent = false;
  float peaks[8] = {};
  /** The take stopped by itself (disk full, device gone), or why the input fails right now. */
  std::string error;
  bool failed = false;
};

/** Starts capturing to options.rawPath. One take at a time. */
bool recorderStart(const RecorderStartOptions& options, std::string& error);
/** Stops, writes what is buffered, closes the raw file. Returns the take's final status. */
RecorderStatus recorderStop();
/** The running take; peaks since the last call. */
RecorderStatus recorderStatus();
