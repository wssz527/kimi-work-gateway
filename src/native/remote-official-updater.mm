#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <Security/Security.h>
#import <CommonCrypto/CommonDigest.h>
#import <objc/runtime.h>
#include <node_api.h>
#include <dlfcn.h>
#include <libproc.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <atomic>
#include <mutex>

@interface NSObject (KWOfficialSquirrel)
+ (id)currentApplicationSignature:(NSError **)error;
+ (NSString *)shipItJobLabel;
+ (id)shipItJobDictionary;
+ (id)mainThreadScheduler;
- (NSData *)requirementData;
- (id)verifyBundleAtURL:(NSURL *)url;
- (id)initWithUpdateRequest:(NSURLRequest *)request requestForDownload:(NSURLRequest *(^)(NSURL *))download;
- (id)checkForUpdatesCommand;
- (id)execute:(id)value;
- (NSUInteger)state;
- (id)shipItStateURL;
- (id)relaunchToInstallUpdate;
- (id)deliverOn:(id)scheduler;
- (id)subscribeNext:(void (^)(id))next error:(void (^)(NSError *))error completed:(void (^)(void))completed;
- (void)dispose;
- (id)update;
- (NSBundle *)bundle;
- (NSString *)releaseNotes;
- (NSString *)releaseName;
- (NSDate *)releaseDate;
- (NSURL *)updateURL;
@end

static NSString *const BundleID = @"com.moonshot.kimichat";
static NSString *const TeamID = @"2J9472RW75";
static NSString *ApplicationPath, *BundlePath, *FrameworkPath, *CacheHome, *JobLabel, *StatePath, *RequirementDigest;
static pid_t ParentPID;
static int ScopeLock = -1;
static BOOL Initialized, Ready, Configured, LaunchObserved, TerminationObserved, ParentWatchRegistered, RelaunchArmed, ExitRequested;
static std::atomic<bool> ParentDead(false), Busy(false), Staged(false), AvailableSent(false);
static dispatch_source_t ParentWatch;
static id Updater, Downloaded;
static NSMutableArray *Subscriptions, *Notifications;
static NSMutableArray<NSDictionary *> *Events;
static std::mutex EventMutex;
static Method LabelMethod;
static IMP OriginalLabelIMP;
static NSMutableArray<NSValue *> *SecurityMethods;
static NSMutableArray<NSValue *> *SecurityIMPs;
static void *FrameworkHandle;
static NSUInteger PumpCount;

static void Fail(NSString *code) { @throw [NSException exceptionWithName:@"KWOfficialUpdater" reason:code userInfo:nil]; }
static void MainThread(void) { if (![NSThread isMainThread]) Fail(@"remote_update_main_thread_required"); }
static NSString *Canonical(NSString *path) { return path.stringByStandardizingPath.stringByResolvingSymlinksInPath; }
static BOOL Within(NSString *path, NSString *root) { return [Canonical(path) hasPrefix:[Canonical(root) stringByAppendingString:@"/"]]; }
static NSString *Hex(NSData *data) {
  if (![data isKindOfClass:NSData.class]) Fail(@"remote_update_signature_unverified");
  unsigned char bytes[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(data.bytes, (CC_LONG)data.length, bytes);
  NSMutableString *result = [NSMutableString stringWithCapacity:64];
  for (unsigned char byte : bytes) [result appendFormat:@"%02x", byte];
  return result;
}
static NSString *Executable(pid_t pid) {
  char path[PROC_PIDPATHINFO_MAXSIZE] = {};
  return proc_pidpath(pid, path, sizeof(path)) > 0 ? [NSString stringWithUTF8String:path] : nil;
}
static void Enqueue(NSDictionary *event) {
  std::lock_guard<std::mutex> lock(EventMutex);
  if (!Events) Events = [NSMutableArray array];
  if (Events.count < 64) [Events addObject:event];
}
static NSString *ErrorCode(NSError *error) {
  NSError *current = error;
  for (NSUInteger depth = 0; current && depth < 8; depth++, current = current.userInfo[NSUnderlyingErrorKey]) {
    if ([current.domain isEqual:@"SQRLCodeSignatureErrorDomain"]) return @"remote_update_signature_invalid";
  }
  if ([error.domain isEqual:NSURLErrorDomain]) return @"remote_update_network_failed";
  return @"remote_update_check_failed";
}
static void Trace(void) {
  if (!CacheHome) return;
  NSDictionary *state = @{@"pid": @(getpid()), @"parentPid": @(ParentPID), @"launchNotification": @(LaunchObserved),
    @"parentWatchRegistered": @(ParentWatchRegistered), @"parentExitObserved": @(ParentDead.load()),
    @"nativeTerminationRequested": @(ExitRequested), @"willTerminateNotification": @(TerminationObserved),
    @"staged": @(Staged.load()), @"relaunchArmed": @(RelaunchArmed), @"jobLabel": JobLabel ?: @""};
  NSData *data = [NSJSONSerialization dataWithJSONObject:state options:0 error:NULL];
  int fd = open([[CacheHome stringByAppendingPathComponent:@"remote-updater-lifecycle.json"] fileSystemRepresentation], O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0600);
  if (fd >= 0) { const uint8_t *bytes = (const uint8_t *)data.bytes; size_t left = data.length; while (left) { ssize_t count = write(fd, bytes, left); if (count <= 0) break; bytes += count; left -= count; } close(fd); }
}

@interface KWRemoteUpdaterDelegate : NSObject <NSApplicationDelegate>
@end
@implementation KWRemoteUpdaterDelegate
- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender {
  (void)sender;
  return ParentDead.load() ? NSTerminateNow : NSTerminateCancel;
}
- (void)applicationWillTerminate:(NSNotification *)notification { (void)notification; TerminationObserved = YES; Trace(); }
@end
static KWRemoteUpdaterDelegate *ApplicationDelegate;

@interface KWRemoteUpdaterObserver : NSObject
@end
@implementation KWRemoteUpdaterObserver
- (void)observeValueForKeyPath:(NSString *)keyPath ofObject:(id)object change:(NSDictionary *)change context:(void *)context {
  (void)keyPath; (void)context;
  if (object != Updater) return;
  NSUInteger state = [change[NSKeyValueChangeNewKey] unsignedIntegerValue];
  if (state == 1) Enqueue(@{@"type": @"checking-for-update"});
  if (state == 2 && !AvailableSent.exchange(true)) Enqueue(@{@"type": @"update-available"});
}
@end
static KWRemoteUpdaterObserver *UpdaterObserver;

@interface KWSignalResult : NSObject
@property (atomic, strong) id value;
@property (atomic, strong) NSError *error;
@property (atomic) BOOL done;
@end
@implementation KWSignalResult
@end
static id ReadSignal(id signal) {
  KWSignalResult *result = [KWSignalResult new];
  id disposable = [signal subscribeNext:^(id value) { result.value = value; } error:^(NSError *error) { result.error = error; result.done = YES; } completed:^{ result.done = YES; }];
  CFAbsoluteTime deadline = CFAbsoluteTimeGetCurrent() + 3;
  while (!result.done && CFAbsoluteTimeGetCurrent() < deadline) CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.002, true);
  [disposable dispose];
  if (!result.done || result.error || !result.value) Fail(@"remote_update_namespace_unverified");
  return result.value;
}

static SecRequirementRef Trust(NSString *identifier) {
  NSString *text = [NSString stringWithFormat:@"identifier \"%@\" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"%@\"", identifier, TeamID];
  SecRequirementRef requirement = NULL;
  if (SecRequirementCreateWithString((__bridge CFStringRef)text, kSecCSDefaultFlags, &requirement) != errSecSuccess) Fail(@"remote_update_signature_unverified");
  return requirement;
}
static NSString *ValidateCode(NSString *path, NSString *identifier) {
  SecStaticCodeRef code = NULL;
  SecRequirementRef trust = NULL, requirement = NULL;
  CFDataRef data = NULL;
  @try {
    NSURL *url = [NSURL fileURLWithPath:path];
    if (SecStaticCodeCreateWithPath((__bridge CFURLRef)url, kSecCSDefaultFlags, &code) != errSecSuccess) Fail(@"remote_update_signature_unverified");
    trust = Trust(identifier);
    if (SecStaticCodeCheckValidity(code, kSecCSCheckNestedCode | kSecCSStrictValidate | kSecCSCheckAllArchitectures, trust) != errSecSuccess) Fail(@"remote_update_signature_unverified");
    if (SecCodeCopyDesignatedRequirement(code, kSecCSDefaultFlags, &requirement) != errSecSuccess || SecRequirementCopyData(requirement, kSecCSDefaultFlags, &data) != errSecSuccess) Fail(@"remote_update_signature_unverified");
    return Hex((__bridge NSData *)data);
  } @finally { if (data) CFRelease(data); if (requirement) CFRelease(requirement); if (trust) CFRelease(trust); if (code) CFRelease(code); }
}
static void ValidateSelf(void) {
  NSBundle *bundle = NSBundle.mainBundle;
  if (![bundle.bundleIdentifier isEqual:BundleID] || ![Canonical(bundle.executableURL.path) isEqual:ApplicationPath] || ![Canonical(Executable(getpid())) isEqual:ApplicationPath]) Fail(@"remote_update_identity_unverified");
  BundlePath = Canonical(bundle.bundleURL.path);
  RequirementDigest = ValidateCode(BundlePath, BundleID);
  SecCodeRef code = NULL;
  SecRequirementRef trust = Trust(BundleID), designated = NULL;
  CFDataRef data = NULL;
  @try {
    if (SecCodeCopySelf(kSecCSDefaultFlags, &code) != errSecSuccess || SecCodeCheckValidity(code, kSecCSDefaultFlags, trust) != errSecSuccess || SecCodeCopyDesignatedRequirement(code, kSecCSDefaultFlags, &designated) != errSecSuccess || SecRequirementCopyData(designated, kSecCSDefaultFlags, &data) != errSecSuccess || ![Hex((__bridge NSData *)data) isEqual:RequirementDigest]) Fail(@"remote_update_identity_unverified");
  } @finally { if (data) CFRelease(data); if (designated) CFRelease(designated); if (trust) CFRelease(trust); if (code) CFRelease(code); }
}
static void MethodFromImage(Method method, NSString *image) {
  Dl_info info = {};
  if (!method || !dladdr((void *)method_getImplementation(method), &info) || !info.dli_fname || ![Canonical([NSString stringWithUTF8String:info.dli_fname]) isEqual:image]) Fail(@"remote_update_framework_unverified");
}
static void OriginalMethods(void) {
  for (NSUInteger i = 0; i < SecurityMethods.count; i++) if (method_getImplementation((Method)SecurityMethods[i].pointerValue) != (IMP)SecurityIMPs[i].pointerValue) Fail(@"remote_update_signature_unverified");
}
static Class SquirrelClass(NSString *name) {
  Class cls = NSClassFromString(name);
  const char *image = cls ? class_getImageName(cls) : NULL;
  if (!image || ![Canonical([NSString stringWithUTF8String:image]) isEqual:FrameworkPath]) Fail(@"remote_update_framework_unverified");
  return cls;
}
static void LoadFramework(void) {
  NSString *framework = [BundlePath stringByAppendingPathComponent:@"Contents/Frameworks/Squirrel.framework"];
  FrameworkPath = Canonical([framework stringByAppendingPathComponent:@"Squirrel"]);
  ValidateCode(framework, @"com.github.Squirrel");
  ValidateCode([framework stringByAppendingPathComponent:@"Resources/ShipIt"], @"ShipIt");
  Class existing = NSClassFromString(@"SQRLCodeSignature");
  if (!existing) {
    FrameworkHandle = dlopen(FrameworkPath.fileSystemRepresentation, RTLD_NOW | RTLD_LOCAL);
    if (!FrameworkHandle) Fail(@"remote_update_framework_unverified");
  }
  SecurityMethods = [NSMutableArray array]; SecurityIMPs = [NSMutableArray array];
  for (NSArray *spec in @[@[@"SQRLCodeSignature", @"currentApplicationSignature:", @YES], @[@"SQRLCodeSignature", @"verifyBundleAtURL:", @NO], @[@"SQRLCodeSignature", @"requirementData", @NO], @[@"SQRLUpdater", @"initWithUpdateRequest:requestForDownload:", @NO], @[@"SQRLUpdater", @"checkForUpdatesCommand", @NO], @[@"SQRLUpdater", @"relaunchToInstallUpdate", @NO], @[@"SQRLUpdater", @"shipItStateURL", @NO], @[@"SQRLShipItLauncher", @"shipItJobDictionary", @YES]]) {
    Class cls = SquirrelClass(spec[0]); SEL selector = NSSelectorFromString(spec[1]);
    Method method = [spec[2] boolValue] ? class_getClassMethod(cls, selector) : class_getInstanceMethod(cls, selector);
    MethodFromImage(method, FrameworkPath);
    [SecurityMethods addObject:[NSValue valueWithPointer:method]];
    [SecurityIMPs addObject:[NSValue valueWithPointer:(const void *)method_getImplementation(method)]];
  }
  NSError *error = nil;
  id signature = [SquirrelClass(@"SQRLCodeSignature") currentApplicationSignature:&error];
  if (!signature || ![Hex([signature requirementData]) isEqual:RequirementDigest]) Fail(@"remote_update_signature_unverified");
}
static id PrivateLabel(id self, SEL selector) {
  if (self == NSClassFromString(@"SQRLShipItLauncher")) return JobLabel;
  return ((id (*)(id, SEL))OriginalLabelIMP)(self, selector);
}
static void Namespace(void) {
  NSString *seed = [NSString stringWithFormat:@"%u:%@", getuid(), CacheHome];
  JobLabel = [@"com.moonshot.kimichat.kimi-work." stringByAppendingString:[[Hex([seed dataUsingEncoding:NSUTF8StringEncoding]) substringToIndex:24] stringByAppendingString:@".ShipIt"]];
  LabelMethod = class_getClassMethod(SquirrelClass(@"SQRLShipItLauncher"), @selector(shipItJobLabel));
  MethodFromImage(LabelMethod, FrameworkPath);
  OriginalLabelIMP = method_getImplementation(LabelMethod);
  method_setImplementation(LabelMethod, (IMP)PrivateLabel);
  NSDictionary *job = ReadSignal([SquirrelClass(@"SQRLShipItLauncher") shipItJobDictionary]);
  NSArray *args = job[@"ProgramArguments"];
  NSString *expectedShipIt = Canonical([BundlePath stringByAppendingPathComponent:@"Contents/Frameworks/Squirrel.framework/Resources/ShipIt"]);
  if (![job[@"Label"] isEqual:JobLabel] || args.count != 3 || ![Canonical(args[0]) isEqual:expectedShipIt] || ![args[1] isEqual:JobLabel] || !Within(args[2], CacheHome) || ![job[@"MachServices"][JobLabel] boolValue] || !Within(job[@"StandardOutPath"], CacheHome) || !Within(job[@"StandardErrorPath"], CacheHome)) Fail(@"remote_update_namespace_unverified");
  StatePath = Canonical(args[2]);
  NSString *expected = [[[[CacheHome stringByAppendingPathComponent:@"Library/Caches"] stringByAppendingPathComponent:JobLabel] stringByAppendingPathComponent:@"ShipItState.plist"] stringByStandardizingPath];
  if (![StatePath isEqual:Canonical(expected)]) Fail(@"remote_update_namespace_unverified");
}
static void DisposeUpdater(void) {
  for (id disposable in Subscriptions) [disposable dispose];
  [Subscriptions removeAllObjects];
  if (Updater) { [Updater removeObserver:UpdaterObserver forKeyPath:@"state"]; Updater = nil; }
}
static void CreateUpdater(NSURLRequest *request, NSDictionary *headers) {
  DisposeUpdater();
  Updater = [[SquirrelClass(@"SQRLUpdater") alloc] initWithUpdateRequest:request requestForDownload:^NSURLRequest *(NSURL *url) {
    NSMutableURLRequest *download = [NSMutableURLRequest requestWithURL:url];
    download.allHTTPHeaderFields = headers;
    return download;
  }];
  if (!Updater) Fail(@"remote_update_native_unavailable");
  if (!UpdaterObserver) UpdaterObserver = [KWRemoteUpdaterObserver new];
  [Updater addObserver:UpdaterObserver forKeyPath:@"state" options:NSKeyValueObservingOptionNew context:NULL];
  NSURL *state = ReadSignal([Updater shipItStateURL]);
  if (![Canonical(state.path) isEqual:StatePath]) Fail(@"remote_update_namespace_unverified");
  OriginalMethods();
}
static NSDictionary *Snapshot(void) {
  MainThread();
  NSRunningApplication *current = NSRunningApplication.currentApplication;
  return @{@"supportsOfficialUpdates": @(Ready), @"identityVerified": @(Ready && current.processIdentifier == getpid() && [Canonical(current.bundleURL.path) isEqual:BundlePath] && [current.bundleIdentifier isEqual:BundleID]),
    @"application": ApplicationPath ?: @"", @"pid": @(getpid()), @"parentPid": @(ParentPID), @"bundleURL": current.bundleURL.path ?: @"", @"bundleIdentifier": current.bundleIdentifier ?: @"",
    @"requirementSHA256": RequirementDigest ?: @"", @"jobLabel": JobLabel ?: @"", @"statePath": StatePath ?: @"", @"cacheHome": CacheHome ?: @"", @"namespaceVerified": @(Ready),
    @"launchNotification": @(LaunchObserved), @"parentWatchRegistered": @(ParentWatchRegistered), @"parentExitObserved": @(ParentDead.load()),
    @"activationPolicy": NSApp ? @(NSApp.activationPolicy) : @(-1), @"windowCount": NSApp ? @(NSApp.windows.count) : @0,
    @"busy": @(Busy.load()), @"staged": @(Staged.load()), @"relaunchArmed": @(RelaunchArmed), @"pumpCount": @(PumpCount)};
}
static NSDictionary *Initialize(NSDictionary *config) {
  MainThread();
  if (Initialized) Fail(@"remote_update_already_initialized");
  pid_t parent = [config[@"parentPid"] intValue];
  NSString *application = config[@"application"], *home = config[@"cacheHome"];
  if (parent <= 1 || parent != getppid()) Fail(@"remote_update_parent_unverified");
  struct proc_bsdinfo info = {};
  if (proc_pidinfo(parent, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info) || info.pbi_uid != getuid()) Fail(@"remote_update_parent_unverified");
  if (![home isKindOfClass:NSString.class] || !home.isAbsolutePath || ![Canonical(home) isEqual:home] || ![application isKindOfClass:NSString.class] || !application.isAbsolutePath) Fail(@"remote_update_scope_unverified");
  struct stat statInfo = {};
  if (lstat(home.fileSystemRepresentation, &statInfo) || !S_ISDIR(statInfo.st_mode) || statInfo.st_uid != getuid() || (statInfo.st_mode & 0077)) Fail(@"remote_update_scope_unverified");
  NSDictionary *environment = NSProcessInfo.processInfo.environment;
  if (![Canonical(environment[@"HOME"]) isEqual:home] || ![Canonical(environment[@"CFFIXED_USER_HOME"]) isEqual:home] || ![Canonical(NSHomeDirectory()) isEqual:home] || !Within(environment[@"TMPDIR"], home)) Fail(@"remote_update_scope_unverified");
  NSString *cache = [[[NSFileManager.defaultManager URLsForDirectory:NSCachesDirectory inDomains:NSUserDomainMask] firstObject] path];
  if (!Within(cache, home)) Fail(@"remote_update_scope_unverified");
  CacheHome = home; ParentPID = parent; ApplicationPath = Canonical(application);
  ScopeLock = open([[home stringByAppendingPathComponent:@".official-updater.lock"] fileSystemRepresentation], O_CREAT | O_RDWR | O_NOFOLLOW, 0600);
  if (ScopeLock < 0 || flock(ScopeLock, LOCK_EX | LOCK_NB)) Fail(@"remote_update_scope_busy");
  ValidateSelf(); LoadFramework();
  Notifications = [NSMutableArray array]; Subscriptions = [NSMutableArray array];
  [Notifications addObject:[NSNotificationCenter.defaultCenter addObserverForName:NSApplicationDidFinishLaunchingNotification object:nil queue:nil usingBlock:^(NSNotification *) { LaunchObserved = YES; Trace(); }]];
  [Notifications addObject:[NSNotificationCenter.defaultCenter addObserverForName:NSApplicationWillTerminateNotification object:nil queue:nil usingBlock:^(NSNotification *) { TerminationObserved = YES; Trace(); }]];
  ParentWatch = dispatch_source_create(DISPATCH_SOURCE_TYPE_PROC, (uintptr_t)ParentPID, DISPATCH_PROC_EXIT, dispatch_get_main_queue());
  if (!ParentWatch) Fail(@"remote_update_parent_unverified");
  dispatch_source_set_registration_handler(ParentWatch, ^{ ParentWatchRegistered = YES; Trace(); });
  dispatch_source_set_event_handler(ParentWatch, ^{ ParentDead.store(true); Trace(); });
  dispatch_resume(ParentWatch);
  [NSApplication sharedApplication];
  ApplicationDelegate = [KWRemoteUpdaterDelegate new]; NSApp.delegate = ApplicationDelegate;
  if (![NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited]) Fail(@"remote_update_appkit_unavailable");
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 20 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
    [NSApp stop:nil];
    NSEvent *event = [NSEvent otherEventWithType:NSEventTypeApplicationDefined location:NSZeroPoint modifierFlags:0 timestamp:0 windowNumber:0 context:nil subtype:0 data1:0 data2:0];
    [NSApp postEvent:event atStart:YES];
  });
  [NSApp run];
  Initialized = YES;
  CFAbsoluteTime deadline = CFAbsoluteTimeGetCurrent() + 1;
  while (!ParentWatchRegistered && CFAbsoluteTimeGetCurrent() < deadline) CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.002, true);
  NSRunningApplication *current = NSRunningApplication.currentApplication;
  if (!LaunchObserved || !ParentWatchRegistered || ParentDead.load() || getppid() != ParentPID || current.processIdentifier != getpid() || ![Canonical(current.bundleURL.path) isEqual:BundlePath] || ![current.bundleIdentifier isEqual:BundleID] || NSApp.activationPolicy != NSApplicationActivationPolicyProhibited || NSApp.windows.count) Fail(@"remote_update_appkit_unavailable");
  Namespace();
  CreateUpdater([NSURLRequest requestWithURL:[NSURL fileURLWithPath:[CacheHome stringByAppendingPathComponent:@"unconfigured-feed"]]], @{});
  Ready = YES; Trace();
  return Snapshot();
}
static NSDictionary *SetFeed(NSDictionary *feed) {
  MainThread(); OriginalMethods();
  if (!Ready || Busy.load() || Staged.load() || ParentDead.load()) Fail(@"remote_update_not_idle");
  NSURL *url = [NSURL URLWithString:feed[@"url"]];
  if (!url || ![@[@"https", @"http"] containsObject:url.scheme.lowercaseString] || !url.host.length) Fail(@"remote_update_feed_invalid");
  NSDictionary *headers = feed[@"headers"] ?: @{};
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url]; request.allHTTPHeaderFields = headers;
  CreateUpdater(request, headers); Configured = YES;
  return @{@"configured": @YES};
}
static void DownloadEvent(id downloaded) {
  if (![downloaded respondsToSelector:@selector(update)] || ![downloaded respondsToSelector:@selector(bundle)]) Fail(@"remote_update_staging_unverified");
  NSBundle *bundle = [downloaded bundle];
  if (!Within(bundle.bundleURL.path, CacheHome) || ![[NSFileManager defaultManager] fileExistsAtPath:StatePath]) Fail(@"remote_update_staging_unverified");
  id update = [(NSObject *)downloaded update];
  NSMutableDictionary *event = [@{@"type": @"update-downloaded"} mutableCopy];
  if ([[update releaseNotes] isKindOfClass:NSString.class]) event[@"releaseNotes"] = [[update releaseNotes] substringToIndex:MIN((NSUInteger)16384, [update releaseNotes].length)];
  if ([[update releaseName] isKindOfClass:NSString.class]) event[@"releaseName"] = [[update releaseName] substringToIndex:MIN((NSUInteger)512, [update releaseName].length)];
  if ([[update releaseDate] isKindOfClass:NSDate.class]) event[@"releaseDate"] = @([[update releaseDate] timeIntervalSince1970] * 1000);
  if ([[update updateURL] isKindOfClass:NSURL.class]) event[@"updateURL"] = [[update updateURL] absoluteString];
  Staged.store(true); Trace(); Enqueue(event);
}
static NSDictionary *Check(void) {
  MainThread(); OriginalMethods();
  if (!Ready || !Configured || Staged.load() || ParentDead.load() || Busy.load()) Fail(@"remote_update_check_unavailable");
  Busy.store(true);
  @try {
    AvailableSent.store(false); Downloaded = nil;
    id owner = Updater;
    id signal = [[[Updater checkForUpdatesCommand] execute:nil] deliverOn:[NSClassFromString(@"RACScheduler") mainThreadScheduler]];
    id disposable = [signal subscribeNext:^(id value) { if (owner == Updater) Downloaded = value; } error:^(NSError *error) {
      if (owner != Updater) return;
      Busy.store(false); Enqueue(@{@"type": @"error", @"code": ErrorCode(error)});
    } completed:^{
      if (owner != Updater) return;
      Busy.store(false);
      @try {
        OriginalMethods();
        if (Downloaded && [Updater state] == 3) DownloadEvent(Downloaded);
        else if (!Downloaded) Enqueue(@{@"type": @"update-not-available"});
        else Enqueue(@{@"type": @"error", @"code": @"remote_update_staging_unverified"});
      } @catch (NSException *) { Enqueue(@{@"type": @"error", @"code": @"remote_update_staging_unverified"}); }
    }];
    [Subscriptions addObject:disposable];
    return @{@"checking": @YES};
  } @catch (NSException *error) {
    Busy.store(false);
    @throw error;
  }
}
static NSDictionary *Arm(void) {
  MainThread(); OriginalMethods();
  if (!Ready || !Staged.load() || [Updater state] != 3 || ParentDead.load()) Fail(@"remote_update_not_staged");
  RelaunchArmed = YES; Trace(); return @{@"waitingForParentExit": @YES};
}
static void MaybeTerminate(void) {
  if (!Initialized || !ParentDead.load() || ExitRequested) return;
  ExitRequested = YES; Trace();
  if (RelaunchArmed && Staged.load()) {
    id disposable = [[Updater relaunchToInstallUpdate] subscribeNext:^(id) {} error:^(NSError *) { [NSApp terminate:nil]; } completed:^{}];
    [Subscriptions addObject:disposable];
  } else [NSApp terminate:nil];
}
static NSArray *Pump(void) {
  MainThread(); PumpCount++;
  CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.002, true);
  MaybeTerminate();
  std::lock_guard<std::mutex> lock(EventMutex);
  NSArray *events = [Events copy] ?: @[]; [Events removeAllObjects]; return events;
}
static NSDictionary *VerifyFixture(NSString *path) {
  MainThread(); OriginalMethods();
  if (!Ready || !Within(path, CacheHome) || ![path.pathExtension isEqual:@"app"]) Fail(@"remote_update_fixture_invalid");
  NSError *error = nil; id signature = [SquirrelClass(@"SQRLCodeSignature") currentApplicationSignature:&error];
  KWSignalResult *result = [KWSignalResult new];
  id disposable = [[signature verifyBundleAtURL:[NSURL fileURLWithPath:path]] subscribeNext:^(id) {} error:^(NSError *failure) { result.error = failure; result.done = YES; } completed:^{ result.done = YES; }];
  [disposable dispose];
  if (!result.done) Fail(@"remote_update_verifier_unavailable");
  return @{@"valid": @(!result.error), @"code": result.error ? ErrorCode(result.error) : @"", @"requirementSHA256": Hex([signature requirementData])};
}
static napi_value JS(napi_env env, id object) {
  napi_value value = NULL;
  if (!object || object == NSNull.null) napi_get_null(env, &value);
  else if ([object isKindOfClass:NSString.class]) { NSData *data = [object dataUsingEncoding:NSUTF8StringEncoding]; napi_create_string_utf8(env, (const char *)data.bytes, data.length, &value); }
  else if ([object isKindOfClass:NSNumber.class]) { if (CFGetTypeID((__bridge CFTypeRef)object) == CFBooleanGetTypeID()) napi_get_boolean(env, [object boolValue], &value); else napi_create_double(env, [object doubleValue], &value); }
  else if ([object isKindOfClass:NSArray.class]) { napi_create_array_with_length(env, [object count], &value); for (NSUInteger i = 0; i < [object count]; i++) napi_set_element(env, value, (uint32_t)i, JS(env, object[i])); }
  else if ([object isKindOfClass:NSDictionary.class]) { napi_create_object(env, &value); for (NSString *key in object) napi_set_named_property(env, value, key.UTF8String, JS(env, object[key])); }
  else Fail(@"remote_update_result_invalid");
  return value;
}
static id NativeJSON(napi_env env, napi_value value) {
  napi_value global, json, stringify, text;
  napi_get_global(env, &global); napi_get_named_property(env, global, "JSON", &json); napi_get_named_property(env, json, "stringify", &stringify);
  if (napi_call_function(env, json, stringify, 1, &value, &text) != napi_ok) Fail(@"remote_update_request_invalid");
  size_t length = 0;
  if (napi_get_value_string_utf8(env, text, NULL, 0, &length) != napi_ok || length > 256 * 1024) Fail(@"remote_update_request_invalid");
  NSMutableData *data = [NSMutableData dataWithLength:length + 1];
  napi_get_value_string_utf8(env, text, (char *)data.mutableBytes, length + 1, &length); data.length = length;
  id result = [NSJSONSerialization JSONObjectWithData:data options:NSJSONReadingFragmentsAllowed error:NULL];
  if (!result) Fail(@"remote_update_request_invalid"); return result;
}
static napi_value Call(napi_env env, napi_callback_info info) {
  @autoreleasepool { @try {
    MainThread(); size_t count = 1; napi_value values[1] = {}; void *data = NULL;
    napi_get_cb_info(env, info, &count, values, NULL, &data); uintptr_t operation = (uintptr_t)data; id result;
    if (operation == 0) result = Initialize(count ? NativeJSON(env, values[0]) : @{});
    else if (operation == 1) result = Snapshot();
    else if (operation == 2) result = SetFeed(count ? NativeJSON(env, values[0]) : @{});
    else if (operation == 3) result = Check();
    else if (operation == 4) result = Arm();
    else if (operation == 5) result = Pump();
    else if (operation == 6) result = VerifyFixture(count ? NativeJSON(env, values[0]) : @"");
    else Fail(@"remote_update_request_invalid");
    return JS(env, result);
  } @catch (NSException *error) {
    NSString *code = [error.name isEqual:@"KWOfficialUpdater"] ? error.reason : @"remote_update_native_failed";
    napi_throw_error(env, code.UTF8String, code.UTF8String); return NULL;
  } }
}
static void Cleanup(void *) {
  if (LabelMethod && method_getImplementation(LabelMethod) == (IMP)PrivateLabel) method_setImplementation(LabelMethod, OriginalLabelIMP);
  if (ParentWatch) dispatch_source_cancel(ParentWatch);
  if (ScopeLock >= 0) { close(ScopeLock); ScopeLock = -1; }
}
NAPI_MODULE_INIT() {
  const char *names[] = {"initialize", "inspect", "setFeed", "check", "armRelaunch", "pump", "verifyFixture"};
  for (uintptr_t i = 0; i < 7; i++) { napi_value function; napi_create_function(env, names[i], NAPI_AUTO_LENGTH, Call, (void *)i, &function); napi_set_named_property(env, exports, names[i], function); }
  napi_add_env_cleanup_hook(env, Cleanup, NULL); return exports;
}
