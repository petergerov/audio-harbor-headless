// FxStage end to end, without a device: decoded PCM → harbor-fx (test plugins) → read() as a
// player would. Run: fx-stage-test <harbor-fx> <harbor-test-gain.clap>
#include "FxClient.h"
#include "FxStage.h"

#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <string>
#include <thread>
#include <vector>

#include <unistd.h>

namespace {

int g_failures = 0;

void check(bool ok, const char* what) {
  std::printf("%s %s\n", ok ? "ok  " : "FAIL", what);
  if (!ok) ++g_failures;
}

/** Reads `frames` from `pos` like a device callback: retries while the rack is not ready. */
std::vector<float> pull(FxStage& stage, size_t pos, size_t frames, uint16_t ch) {
  std::vector<float> out(frames * ch);
  size_t done = 0;
  for (int tries = 0; done < frames && tries < 5000; ++tries) {
    const size_t got = stage.read(pos + done, out.data() + done * ch, std::min<size_t>(512, frames - done));
    if (got == 0) std::this_thread::sleep_for(std::chrono::milliseconds(1));
    done += got;
  }
  out.resize(done * ch);
  return out;
}

double maxDiff(const std::vector<float>& a, const float* b, double scale) {
  double worst = 0;
  for (size_t i = 0; i < a.size(); ++i) worst = std::max(worst, std::fabs(double(a[i]) - scale * double(b[i])));
  return worst;
}

std::string chain(const std::string& plugin, const char* id) {
  return std::string(R"({"cmd":"setChain","inserts":[{"id":"t","format":"clap","path":")") + plugin +
         R"(","pluginId":")" + id + R"("}]})";
}

} // namespace

int main(int argc, char** argv) {
  if (argc < 3) {
    std::fprintf(stderr, "usage: fx-stage-test <harbor-fx> <harbor-test-gain.clap>\n");
    return 2;
  }
  FxClient& fx = FxClient::instance();
  fx.setBinary(argv[1]);
  const std::string plugin = argv[2];

  const uint32_t rate = 48000;
  const uint16_t ch = 2;
  const size_t total = rate * 3;
  std::vector<float> dry(total * ch);
  for (size_t i = 0; i < total; ++i) {
    dry[i * 2] = float(0.5 * std::sin(i * 0.031));
    dry[i * 2 + 1] = float(0.4 * std::sin(i * 0.017));
  }
  std::atomic<size_t> ready {total};

  FxStage stage;
  stage.attach(dry.data(), &ready, total, rate, ch);
  check(!stage.engaged(), "empty rack: not engaged");
  auto plain = pull(stage, 1000, 4096, ch);
  check(plain.size() == 4096u * ch && maxDiff(plain, dry.data() + 1000 * ch, 1.0) == 0, "empty rack: PCM untouched");

  const std::string first = fx.control(chain(plugin, "harbor.test.gain"));
  if (!stage.engaged()) std::printf("     setChain → %s\n", first.c_str());
  check(stage.engaged(), "gain in rack: engaged");
  auto half = pull(stage, 0, 20000, ch);
  check(half.size() == 20000u * ch && maxDiff(half, dry.data(), 0.5) < 1e-6, "gain: ×0.5 from frame 0");

  auto seeked = pull(stage, 96000, 8000, ch);
  check(seeked.size() == 8000u * ch && maxDiff(seeked, dry.data() + 96000 * ch, 0.5) < 1e-6, "seek: ×0.5 at the new position");

  fx.control(chain(plugin, "harbor.test.delay"));
  auto delayed = pull(stage, 50000, 8000, ch);
  check(fx.latency() == 64, "delay plugin: latency 64 reported");
  check(delayed.size() == 8000u * ch && maxDiff(delayed, dry.data() + 50000 * ch, 1.0) < 1e-7,
        "delay: latency compensated, output lines up with the dry frames");

  fx.control(chain(plugin, "harbor.test.gain"));
  auto a = pull(stage, 10000, 2000, ch);
  FxStage::setBypassed(true);
  auto fade = pull(stage, 12000, 2000, ch);
  auto b = pull(stage, 14000, 4000, ch);
  check(maxDiff(b, dry.data() + 14000 * ch, 1.0) < 1e-7, "A/B: bypassed is dry");
  bool smooth = true;
  for (size_t i = 1; i < fade.size() / ch; ++i) {
    if (std::fabs(fade[i * 2] - fade[(i - 1) * 2]) > 0.06) smooth = false;
  }
  check(smooth, "A/B: no step in the fade");
  FxStage::setBypassed(false);
  pull(stage, 18000, 1000, ch);
  auto back = pull(stage, 19000, 4000, ch);
  check(maxDiff(back, dry.data() + 19000 * ch, 0.5) < 1e-6, "A/B: back to processed");

  fx.control(R"({"cmd":"setChain","inserts":[]})");
  auto again = pull(stage, 30000, 4000, ch);
  check(!stage.engaged() && maxDiff(again, dry.data() + 30000 * ch, 1.0) == 0, "rack emptied: PCM untouched again");

  // A crash: kill harbor-fx under the stage, the music goes on, the rack comes back.
  fx.control(chain(plugin, "harbor.test.gain"));
  pull(stage, 40000, 4000, ch);
  const uint64_t gen = fx.generation();
  // Only our own child: other hosts on this machine keep their rack.
  const std::string kill = "pkill -9 -P " + std::to_string(getpid()) + " -x harbor-fx";
  if (std::system(kill.c_str()) != 0) std::printf("     (pkill found nothing)\n");
  auto during = pull(stage, 44000, 30000, ch);
  check(during.size() == 30000u * ch, "crash: playback keeps going");
  fx.control(R"({"cmd":"ping"})");
  check(fx.alive() && fx.generation() != gen, "crash: harbor-fx restarted with the chain");
  auto after = pull(stage, 80000, 8000, ch);
  check(maxDiff(after, dry.data() + 80000 * ch, 0.5) < 1e-6, "crash: processed again after restart");

  stage.detach();
  std::printf("%s\n", g_failures ? "FAILED" : "all passed");
  return g_failures ? 1 : 0;
}
