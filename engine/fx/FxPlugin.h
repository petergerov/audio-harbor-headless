#pragma once

#include <condition_variable>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

/** One parameter as the remote shows it. Values are the plugin's own (plain, not 0…1). */
struct FxParam {
  std::string id;
  std::string name;
  /** Group the plugin puts it in ("Band 1"), or empty. */
  std::string module;
  double min = 0;
  double max = 1;
  double def = 0;
  double value = 0;
  /** The plugin's own text for the value ("-3.2 dB", "1.20 kHz"). */
  std::string text;
  bool stepped = false;
  /** The plugin's bypass switch — the rack's power key, not a knob. */
  bool isBypass = false;
  /** Set by the plugin only: a meter (gain reduction, level). */
  bool readOnly = false;
  /** A stepped parameter's values with the plugin's text for each (on / off, Bell, 12 dB/oct). */
  std::vector<std::pair<double, std::string>> options;
};

/** A preset the plugin or its maker ships, or one saved in the plugin's own preset folder. */
struct FxPreset {
  /** Opaque to the host: "factory:3", "file:/…/Warm.aupreset", … */
  std::string id;
  std::string name;
  /** Bank or folder ("Factory", "Mastering"), or empty. */
  std::string group;
};

/** Stepped parameters with at most this many values list them as options. */
constexpr int kMaxOptions = 64;

/** What a plugin file holds, for the plugin list. */
struct FxDescriptor {
  std::string format;  // "clap", "lv2"
  std::string path;    // bundle or file; LV2: the bundle directory
  std::string id;      // CLAP plugin id, LV2 URI
  std::string name;
  std::string vendor;
  std::string version;
  std::vector<std::string> features;
  /** An effect with a stereo main input and output — what the rack takes. */
  bool stereo = false;
  /** Listed without opening it: the host asks `--describe` for the rest (stereo). */
  bool needsDescribe = false;
};

/**
 * Runs work on the one thread the plugins see as their audio thread. harbor-fx is not real
 * time — the engine renders ahead — but plugins check which thread calls them.
 */
class AudioThread {
public:
  AudioThread();
  ~AudioThread();
  AudioThread(const AudioThread&) = delete;
  AudioThread& operator=(const AudioThread&) = delete;

  /** Runs fn on the audio thread and waits for it. */
  void run(const std::function<void()>& fn);
  bool isCurrent() const { return std::this_thread::get_id() == thread_.get_id(); }

private:
  std::thread thread_;
  std::mutex mutex_;
  std::condition_variable cv_;
  const std::function<void()>* job_ = nullptr;
  bool done_ = false;
  bool quit_ = false;
};

/** What an open editor may ask of the window it sits in. */
class EditorFrame {
public:
  virtual ~EditorFrame() = default;
  /** The editor wants this size (points). */
  virtual void resize(uint32_t width, uint32_t height) = 0;
};

/**
 * One loaded insert. Created, activated and asked on the main thread; process() and reset()
 * are called on the audio thread. Audio is planar stereo, processed out of place.
 */
class FxPlugin {
public:
  virtual ~FxPlugin() = default;
  virtual bool activate(double rate, uint32_t maxBlock, std::string& error) = 0;
  virtual void deactivate() = 0;
  /** Audio thread: clear delay lines and tails (seek, new track at the same rate). */
  virtual void reset() = 0;
  /** Audio thread. */
  virtual void process(const float* const* in, float* const* out, uint32_t frames) = 0;
  virtual uint32_t latency() = 0;
  virtual std::vector<FxParam> params() = 0;
  /** Takes effect from the next process(), or at once while not processing. */
  virtual bool setParam(const std::string& id, double value) = 0;
  /** The value the plugin reads in `text` ("-3.5 dB", "1.2 kHz"); false when it cannot. */
  virtual bool parse(const std::string& id, const std::string& text, double& value) = 0;
  virtual bool saveState(std::vector<uint8_t>& out) = 0;
  virtual bool loadState(const std::vector<uint8_t>& in) = 0;
  /** The presets there are for this plugin, factory ones first. */
  virtual std::vector<FxPreset> presets() { return {}; }
  /** One of presets(), into the running unit. */
  virtual bool loadPreset(const std::string& id, std::string& error) {
    (void)id;
    error = "This plugin has no presets";
    return false;
  }
  /** The plugin has an editor of its own that can open in a window on this machine. */
  virtual bool hasEditor() { return false; }
  /**
   * Main thread: the editor into `parent` (an NSView* on macOS), sized `width` × `height`
   * points. `frame` stays valid until closeEditor().
   */
  virtual bool openEditor(void* parent, EditorFrame& frame, uint32_t& width, uint32_t& height, std::string& error) {
    (void)parent;
    (void)frame;
    (void)width;
    (void)height;
    error = "This plugin has no editor here";
    return false;
  }
  virtual void closeEditor() {}
  /** Main thread, between messages: callbacks the plugin asked for. */
  virtual void idle() {}
  /** The plugin asked to be deactivated and activated again (new latency, ports). */
  virtual bool wantsRestart() { return false; }
};

std::string base64Encode(const std::vector<uint8_t>& data);
bool base64Decode(const std::string& text, std::vector<uint8_t>& out);

/**
 * Preset files ending in `extension` under each root, any depth: id "file:<path>", name the file's
 * stem, group the folder below the root (or `group` for files directly in it). Sorted by group, name.
 */
std::vector<FxPreset> presetFiles(const std::vector<std::string>& roots, const std::string& extension,
                                  const std::string& group);
/** The file behind a "file:" preset id, or empty. */
std::string presetFilePath(const std::string& id);
bool readFile(const std::string& path, std::vector<uint8_t>& out);
/** $HOME, or empty. */
std::string homeDir();

/** Plugin files of a format on this machine, by the format's standard paths. */
std::vector<FxDescriptor> clapList();
/** Every plugin in one CLAP file, with its ports checked. */
std::vector<FxDescriptor> clapDescribe(const std::string& path, std::string& error);
std::unique_ptr<FxPlugin> clapLoad(const std::string& path, const std::string& id, AudioThread& audio,
                                   std::string& error);

#if defined(__APPLE__)
std::vector<FxDescriptor> auList();
std::vector<FxDescriptor> auDescribe(const std::string& id, std::string& error);
std::unique_ptr<FxPlugin> auLoad(const std::string& id, AudioThread& audio, std::string& error);
#endif

#if defined(HARBOR_FX_VST3)
std::vector<FxDescriptor> vst3List();
std::vector<FxDescriptor> vst3Describe(const std::string& path, std::string& error);
std::unique_ptr<FxPlugin> vst3Load(const std::string& path, const std::string& id, AudioThread& audio, std::string& error);
#endif

#if defined(HARBOR_FX_LV2)
std::vector<FxDescriptor> lv2List();
std::vector<FxDescriptor> lv2Describe(const std::string& uri, std::string& error);
std::unique_ptr<FxPlugin> lv2Load(const std::string& uri, AudioThread& audio, std::string& error);
#endif
