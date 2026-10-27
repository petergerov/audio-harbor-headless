// Linux desktop (X11): an event loop on the main thread — poll() over the hand-over pipe, the
// plugins' timers and file descriptors and the X11 connection — and plugin editors in X11 windows.
// libX11 is opened at run time, only with a DISPLAY: a Pi without a desktop needs none of it.
#include "MainLoop.h"

#include <X11/Xatom.h>
#include <X11/Xlib.h>
#include <X11/Xutil.h>

#include <dlfcn.h>
#include <fcntl.h>
#include <poll.h>
#include <unistd.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <map>
#include <mutex>
#include <thread>
#include <type_traits>
#include <vector>

namespace {

using Clock = std::chrono::steady_clock;

/** How often the main thread looks after plugin callbacks and closed windows. */
constexpr auto kIdle = std::chrono::milliseconds(33);

struct Timer {
  std::chrono::milliseconds period;
  Clock::time_point due;
  std::function<void()> fn;
};

struct Watch {
  int fd;
  std::function<void()> fn;
};

/** The libX11 calls this file makes, looked up in libX11.so.6. */
struct X11 {
#define X11_FN(name) decltype(&::name) name = nullptr;
  X11_FN(XInitThreads)
  X11_FN(XOpenDisplay)
  X11_FN(XInternAtom)
  X11_FN(XPending)
  X11_FN(XNextEvent)
  X11_FN(XCreateSimpleWindow)
  X11_FN(XStoreName)
  X11_FN(XChangeProperty)
  X11_FN(XSetWMProtocols)
  X11_FN(XSync)
  X11_FN(XSetWMNormalHints)
  X11_FN(XResizeWindow)
  X11_FN(XMapRaised)
  X11_FN(XFlush)
  X11_FN(XDestroyWindow)
#undef X11_FN

  bool load() {
    void* lib = dlopen("libX11.so.6", RTLD_NOW | RTLD_GLOBAL);
    if (!lib) return false;
    bool ok = true;
    auto get = [&](auto& fn, const char* name) {
      fn = reinterpret_cast<std::remove_reference_t<decltype(fn)>>(dlsym(lib, name));
      ok = ok && fn;
    };
    get(XInitThreads, "XInitThreads");
    get(XOpenDisplay, "XOpenDisplay");
    get(XInternAtom, "XInternAtom");
    get(XPending, "XPending");
    get(XNextEvent, "XNextEvent");
    get(XCreateSimpleWindow, "XCreateSimpleWindow");
    get(XStoreName, "XStoreName");
    get(XChangeProperty, "XChangeProperty");
    get(XSetWMProtocols, "XSetWMProtocols");
    get(XSync, "XSync");
    get(XSetWMNormalHints, "XSetWMNormalHints");
    get(XResizeWindow, "XResizeWindow");
    get(XMapRaised, "XMapRaised");
    get(XFlush, "XFlush");
    get(XDestroyWindow, "XDestroyWindow");
    return ok;
  }
};
X11 xlib;

/** This process's own X11 connection, for its windows (plugins open their own). */
Display* g_display = nullptr;
Atom g_wmDelete = None;
/** Our windows and whether they were closed on the screen. */
std::map<Window, std::atomic<bool>*> g_windows;

bool g_looping = false;
std::thread::id g_mainThread;
int g_wake[2] = {-1, -1};
std::atomic<bool> g_quit {false};

std::mutex g_jobMutex;
std::condition_variable g_jobDone;
const std::function<void()>* g_job = nullptr;

std::function<void()> g_idle;
std::map<mainloop::Handle, Timer> g_timers;
std::map<mainloop::Handle, Watch> g_watches;
mainloop::Handle g_next = 1;

void wake() {
  const char c = 1;
  (void)!write(g_wake[1], &c, 1);
}

/** The job handed over, if any: run here, its sender told. */
void runJob() {
  char buf[64];
  while (read(g_wake[0], buf, sizeof(buf)) > 0) {
  }
  std::unique_lock lock(g_jobMutex);
  if (!g_job) return;
  const std::function<void()>* job = g_job;
  lock.unlock();
  (*job)();
  lock.lock();
  g_job = nullptr;
  g_jobDone.notify_all();
}

void readX11() {
  while (xlib.XPending(g_display)) {
    XEvent ev;
    xlib.XNextEvent(g_display, &ev);
    if (ev.type == ClientMessage && Atom(ev.xclient.data.l[0]) == g_wmDelete) {
      auto it = g_windows.find(ev.xclient.window);
      if (it != g_windows.end()) it->second->store(true);
    }
  }
}

/** Callbacks can add or remove timers and watches: work on a copy of the handles. */
template <typename Map>
std::vector<mainloop::Handle> handles(const Map& map) {
  std::vector<mainloop::Handle> out;
  for (const auto& [h, _] : map) out.push_back(h);
  return out;
}

void runTimers() {
  const auto now = Clock::now();
  for (auto h : handles(g_timers)) {
    auto it = g_timers.find(h);
    if (it == g_timers.end() || it->second.due > now) continue;
    it->second.due = now + it->second.period;
    auto fn = it->second.fn;
    fn();
  }
}

int nextTimeoutMs(Clock::time_point idleDue) {
  auto due = idleDue;
  for (const auto& [_, t] : g_timers) due = std::min(due, t.due);
  const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(due - Clock::now()).count();
  return int(std::max<long long>(0, ms));
}

void loop() {
  auto idleDue = Clock::now() + kIdle;
  while (!g_quit.load()) {
    std::vector<pollfd> fds {{g_wake[0], POLLIN, 0}, {ConnectionNumber(g_display), POLLIN, 0}};
    const auto watched = handles(g_watches);
    for (auto h : watched) fds.push_back({g_watches[h].fd, POLLIN, 0});
    // Events Xlib already read into its queue would not wake poll().
    const int timeout = xlib.XPending(g_display) ? 0 : nextTimeoutMs(idleDue);
    poll(fds.data(), nfds_t(fds.size()), timeout);
    if (fds[0].revents) runJob();
    readX11();
    for (size_t i = 0; i < watched.size(); ++i) {
      if (!fds[i + 2].revents) continue;
      auto it = g_watches.find(watched[i]);
      if (it == g_watches.end()) continue;
      auto fn = it->second.fn;
      fn();
    }
    runTimers();
    if (Clock::now() >= idleDue) {
      idleDue = Clock::now() + kIdle;
      if (g_idle) g_idle();
    }
  }
}

} // namespace

namespace mainloop {

bool hasScreen() {
  static const bool screen = [] {
    const char* display = std::getenv("DISPLAY");
    if (!display || !*display || !xlib.load()) return false;
    // Plugins may call Xlib from threads of their own.
    xlib.XInitThreads();
    g_display = xlib.XOpenDisplay(nullptr);
    if (!g_display) return false;
    g_wmDelete = xlib.XInternAtom(g_display, "WM_DELETE_WINDOW", False);
    return true;
  }();
  return screen;
}

int run(const std::function<int()>& serve) {
  if (!hasScreen() || pipe(g_wake) != 0) return serve();
  fcntl(g_wake[0], F_SETFL, O_NONBLOCK);
  g_mainThread = std::this_thread::get_id();
  g_looping = true;
  int code = 0;
  std::thread reader([&] {
    code = serve();
    g_quit = true;
    wake();
  });
  loop();
  reader.join();
  g_looping = false;
  return code;
}

void sync(const std::function<void()>& fn) {
  if (!g_looping || std::this_thread::get_id() == g_mainThread) {
    fn();
    return;
  }
  std::unique_lock lock(g_jobMutex);
  g_job = &fn;
  wake();
  g_jobDone.wait(lock, [] { return g_job == nullptr; });
}

void setIdle(std::function<void()> fn) {
  g_idle = std::move(fn);
}

Handle addTimer(uint32_t ms, std::function<void()> fn) {
  if (!g_looping) return 0;
  const auto period = std::chrono::milliseconds(std::max<uint32_t>(ms, 1));
  g_timers[g_next] = {period, Clock::now() + period, std::move(fn)};
  return g_next++;
}

Handle addFd(int fd, std::function<void()> fn) {
  if (!g_looping) return 0;
  g_watches[g_next] = {fd, std::move(fn)};
  return g_next++;
}

void remove(Handle handle) {
  g_timers.erase(handle);
  g_watches.erase(handle);
}

} // namespace mainloop

namespace {

class X11EditorWindow final : public EditorWindow, public EditorFrame {
public:
  explicit X11EditorWindow(FxPlugin& plugin) : plugin_(plugin) {}

  ~X11EditorWindow() override {
    if (open_) plugin_.closeEditor();
    g_windows.erase(window_);
    if (window_) xlib.XDestroyWindow(g_display, window_);
    xlib.XFlush(g_display);
  }

  bool open(const std::string& title, std::string& error) {
    const int screen = DefaultScreen(g_display);
    window_ = xlib.XCreateSimpleWindow(g_display, RootWindow(g_display, screen), 0, 0, 640, 400, 0,
                                  BlackPixel(g_display, screen), BlackPixel(g_display, screen));
    xlib.XStoreName(g_display, window_, title.c_str());
    xlib.XChangeProperty(g_display, window_, xlib.XInternAtom(g_display, "_NET_WM_NAME", False),
                    xlib.XInternAtom(g_display, "UTF8_STRING", False), 8, PropModeReplace,
                    reinterpret_cast<const unsigned char*>(title.data()), int(title.size()));
    xlib.XSetWMProtocols(g_display, window_, &g_wmDelete, 1);
    g_windows[window_] = &closed_;
    // The plugin draws through a connection of its own: the window must exist on the server.
    xlib.XSync(g_display, False);
    uint32_t width = 640, height = 400;
    if (!plugin_.openEditor(reinterpret_cast<void*>(uintptr_t(window_)), *this, width, height, error)) return false;
    open_ = true;
    resize(width, height);
    xlib.XMapRaised(g_display, window_);
    xlib.XFlush(g_display);
    return true;
  }

  void resize(uint32_t width, uint32_t height) override {
    if (width == 0 || height == 0) return;
    // Its size is the editor's: the window manager offers no resizing.
    XSizeHints hints {};
    hints.flags = PMinSize | PMaxSize;
    hints.min_width = hints.max_width = int(width);
    hints.min_height = hints.max_height = int(height);
    xlib.XSetWMNormalHints(g_display, window_, &hints);
    xlib.XResizeWindow(g_display, window_, width, height);
    xlib.XFlush(g_display);
  }

  bool closedOnScreen() const override { return closed_.load(); }
  long number() const override { return long(window_); }

private:
  FxPlugin& plugin_;
  Window window_ = 0;
  std::atomic<bool> closed_ {false};
  bool open_ = false;
};

} // namespace

std::unique_ptr<EditorWindow> openEditorWindow(FxPlugin& plugin, const std::string& title, std::string& error) {
  if (!g_looping || std::this_thread::get_id() != g_mainThread) {
    error = "This host has no screen to show the editor on";
    return nullptr;
  }
  auto window = std::make_unique<X11EditorWindow>(plugin);
  if (!window->open(title, error)) return nullptr;
  return window;
}
