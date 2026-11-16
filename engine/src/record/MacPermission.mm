#import <AVFoundation/AVFoundation.h>

/**
 * Whether macOS lets this process read audio inputs (Privacy → Microphone): 1 granted,
 * 0 not asked yet (Core Audio asks on the first start), -1 denied or restricted.
 * Without it an input delivers only silence, without any error.
 */
int macAudioInputAccess() {
  switch ([AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio]) {
    case AVAuthorizationStatusAuthorized: return 1;
    case AVAuthorizationStatusNotDetermined: return 0;
    default: return -1;
  }
}
