// An Audio Unit's editor view: the extension's view controller (AUv3), the unit's Cocoa view
// (AUv2), or Core Audio Kit's generic view of its parameters.
#import <AppKit/AppKit.h>
#import <AudioToolbox/AudioToolbox.h>
#import <AudioUnit/AUCocoaUIView.h>
#import <CoreAudioKit/CoreAudioKit.h>

#include <cstdint>
#include <string>

namespace {

/** How long an AUv3 extension may take to hand over its view. */
constexpr double kViewTimeoutSecs = 5.0;

/** AUv3: the view of the controller the extension hands over, waited for with the run loop turning. */
NSView* extensionView(AudioComponentInstance unit) {
  __block NSViewController* controller = nil;
  __block bool answered = false;
  void (^received)(AUViewControllerBase*) = ^(AUViewControllerBase* vc) {
    controller = vc;
    answered = true;
  };
  if (AudioUnitSetProperty(unit, kAudioUnitProperty_RequestViewController, kAudioUnitScope_Global, 0, &received,
                           sizeof(received)) != noErr) {
    return nil;
  }
  NSDate* until = [NSDate dateWithTimeIntervalSinceNow:kViewTimeoutSecs];
  while (!answered && [until timeIntervalSinceNow] > 0) {
    [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.02]];
  }
  return controller.view;
}

/** AUv2: the view class the unit names in its bundle. */
NSView* cocoaView(AudioComponentInstance unit) {
  UInt32 size = 0;
  Boolean writable = false;
  if (AudioUnitGetPropertyInfo(unit, kAudioUnitProperty_CocoaUI, kAudioUnitScope_Global, 0, &size, &writable) != noErr ||
      size < sizeof(AudioUnitCocoaViewInfo)) {
    return nil;
  }
  std::string buffer(size, '\0');
  auto* info = reinterpret_cast<AudioUnitCocoaViewInfo*>(buffer.data());
  if (AudioUnitGetProperty(unit, kAudioUnitProperty_CocoaUI, kAudioUnitScope_Global, 0, info, &size) != noErr) return nil;
  NSURL* url = (__bridge_transfer NSURL*)info->mCocoaAUViewBundleLocation;
  NSString* className = (__bridge_transfer NSString*)info->mCocoaAUViewClass[0];
  NSBundle* bundle = url ? [NSBundle bundleWithURL:url] : nil;
  Class factoryClass = className ? [bundle classNamed:className] : nil;
  if (!factoryClass || ![factoryClass conformsToProtocol:@protocol(AUCocoaUIBase)]) return nil;
  id<AUCocoaUIBase> factory = [[factoryClass alloc] init];
  return [factory uiViewForAudioUnit:unit withSize:NSMakeSize(640, 400)];
}

/** Every parameter as a slider, for a unit without a view of its own (Apple's effects among them). */
NSView* genericView(AudioComponentInstance unit) {
  AUGenericView* view = [[AUGenericView alloc] initWithAudioUnit:unit displayFlags:AUViewTitleDisplayFlag | AUViewPropertiesDisplayFlag];
  view.showsExpertParameters = YES;
  return view;
}

} // namespace

bool auOpenEditor(AudioComponentInstance unit, void* parent, uint32_t& width, uint32_t& height, std::string& error) {
  NSView* view = extensionView(unit);
  if (!view) view = cocoaView(unit);
  if (!view) view = genericView(unit);
  if (!view) {
    error = "The Audio Unit has no editor";
    return false;
  }
  NSView* host = (__bridge NSView*)parent;
  NSSize size = view.frame.size;
  if (size.width < 1 || size.height < 1) size = view.fittingSize;
  if (size.width < 1 || size.height < 1) size = NSMakeSize(640, 400);
  view.frame = NSMakeRect(0, 0, size.width, size.height);
  [host addSubview:view];
  width = uint32_t(size.width);
  height = uint32_t(size.height);
  return true;
}

void auCloseEditor(void* parent) {
  NSView* host = (__bridge NSView*)parent;
  for (NSView* view in [host.subviews copy]) [view removeFromSuperview];
}
