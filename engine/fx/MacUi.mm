// macOS: the Cocoa run loop on the main thread, and plugin editors in windows of their own.
#include "MainLoop.h"

#import <AppKit/AppKit.h>
#include <CoreGraphics/CoreGraphics.h>

#include <atomic>
#include <thread>

namespace {

/** The protocol loop runs on the main thread itself (no screen): hand nothing over. */
bool g_direct = true;
std::function<void()> g_idle;

/** How often the main thread looks after plugin callbacks and closed windows. */
constexpr NSTimeInterval kIdleSecs = 1.0 / 30.0;

} // namespace

@interface HarborEditorDelegate : NSObject <NSWindowDelegate>
@property(nonatomic) std::atomic<bool>* closed;
@end

@implementation HarborEditorDelegate
- (void)windowWillClose:(NSNotification*)notification {
  (void)notification;
  if (self.closed) self.closed->store(true);
}
@end

namespace mainloop {

bool hasScreen() {
  CFDictionaryRef session = CGSessionCopyCurrentDictionary();
  if (!session) return false;
  const void* onConsole = CFDictionaryGetValue(session, kCGSessionOnConsoleKey);
  const bool yes = onConsole && CFGetTypeID(onConsole) == CFBooleanGetTypeID() &&
                   CFBooleanGetValue(static_cast<CFBooleanRef>(onConsole));
  CFRelease(session);
  return yes;
}

int run(const std::function<int()>& serve) {
  if (!hasScreen()) return serve();
  @autoreleasepool {
    [NSApplication sharedApplication];
    // No Dock icon or menu bar of its own; its windows still come to the front.
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    g_direct = false;
    NSTimer* idle = [NSTimer timerWithTimeInterval:kIdleSecs
                                           repeats:YES
                                             block:^(NSTimer*) {
                                               if (g_idle) g_idle();
                                             }];
    // Also while a window is dragged or resized.
    [[NSRunLoop mainRunLoop] addTimer:idle forMode:NSRunLoopCommonModes];
    int code = 0;
    std::thread reader([&] {
      code = serve();
      dispatch_async(dispatch_get_main_queue(), ^{
        [NSApp stop:nil];
        // stop: takes effect after the next event.
        [NSApp postEvent:[NSEvent otherEventWithType:NSEventTypeApplicationDefined
                                            location:NSZeroPoint
                                       modifierFlags:0
                                           timestamp:0
                                        windowNumber:0
                                             context:nil
                                             subtype:0
                                               data1:0
                                               data2:0]
                 atStart:YES];
      });
    });
    [NSApp run];
    [idle invalidate];
    reader.join();
    return code;
  }
}

void sync(const std::function<void()>& fn) {
  if (g_direct || [NSThread isMainThread]) {
    fn();
    return;
  }
  // Through the run loop, not the main dispatch queue: a plugin that waits for an answer the
  // system sends to that queue (an AUv3 extension starting) gets it while the block runs.
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  CFRunLoopPerformBlock(CFRunLoopGetMain(), kCFRunLoopCommonModes, ^{
    fn();
    dispatch_semaphore_signal(done);
  });
  CFRunLoopWakeUp(CFRunLoopGetMain());
  dispatch_semaphore_wait(done, DISPATCH_TIME_FOREVER);
}

void setIdle(std::function<void()> fn) {
  g_idle = std::move(fn);
}

} // namespace mainloop

namespace {

class MacEditorWindow final : public EditorWindow, public EditorFrame {
public:
  explicit MacEditorWindow(FxPlugin& plugin) : plugin_(plugin) {}

  ~MacEditorWindow() override {
    if (open_) plugin_.closeEditor();
    window_.delegate = nil;
    if (!closed_) [window_ close];
  }

  bool open(const std::string& title, std::string& error) {
    window_ = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 640, 400)
                                          styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                                                    NSWindowStyleMaskMiniaturizable
                                            backing:NSBackingStoreBuffered
                                              defer:NO];
    window_.releasedWhenClosed = NO;
    window_.title = [NSString stringWithUTF8String:title.c_str()];
    delegate_ = [HarborEditorDelegate new];
    delegate_.closed = &closed_;
    window_.delegate = delegate_;
    uint32_t width = 640, height = 400;
    if (!plugin_.openEditor((__bridge void*)window_.contentView, *this, width, height, error)) return false;
    open_ = true;
    resize(width, height);
    [window_ center];
    [window_ makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
    return true;
  }

  void resize(uint32_t width, uint32_t height) override {
    if (width > 0 && height > 0) [window_ setContentSize:NSMakeSize(width, height)];
  }

  bool closedOnScreen() const override { return closed_.load(); }
  long number() const override { return long(window_.windowNumber); }

private:
  FxPlugin& plugin_;
  NSWindow* window_ = nil;
  HarborEditorDelegate* delegate_ = nil;
  std::atomic<bool> closed_ {false};
  bool open_ = false;
};

} // namespace

std::unique_ptr<EditorWindow> openEditorWindow(FxPlugin& plugin, const std::string& title, std::string& error) {
  if (!mainloop::hasScreen() || ![NSThread isMainThread] || !NSApp) {
    error = "This host has no screen to show the editor on";
    return nullptr;
  }
  auto window = std::make_unique<MacEditorWindow>(plugin);
  if (!window->open(title, error)) return nullptr;
  return window;
}
