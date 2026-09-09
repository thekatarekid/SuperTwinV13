// Item-targeted ACL projection for the owner-attended P6-D release gate.
// It never requests, reads, or prints the Keychain item's secret data.

#import <CommonCrypto/CommonDigest.h>
#import <Foundation/Foundation.h>
#import <Security/Security.h>

static int fail(void) {
  fputs("native ACL helper: failed\n", stderr);
  return 1;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc != 5 || strcmp(argv[1], "--service") != 0 || strcmp(argv[3], "--account") != 0) {
      return fail();
    }
    const char *service = argv[2];
    const char *account = argv[4];
    if (service[0] == '\0' || account[0] == '\0') return fail();

    SecKeychainItemRef item = NULL;
    OSStatus status = SecKeychainFindGenericPassword(
      NULL,
      (UInt32)strlen(service), service,
      (UInt32)strlen(account), account,
      NULL, NULL,
      &item
    );
    if (status != errSecSuccess || item == NULL) return fail();

    SecAccessRef access = NULL;
    status = SecKeychainItemCopyAccess(item, &access);
    CFRelease(item);
    if (status != errSecSuccess || access == NULL) return fail();
    CFArrayRef aclList = NULL;
    status = SecAccessCopyACLList(access, &aclList);
    CFRelease(access);
    if (status != errSecSuccess || aclList == NULL) return fail();

    BOOL allowAll = NO;
    NSInteger trustedCount = 0;
    NSInteger authorizationCount = 0;
    NSMutableArray<NSString *> *canonical = [NSMutableArray array];
    for (id rawAcl in (__bridge NSArray *)aclList) {
      SecACLRef acl = (__bridge SecACLRef)rawAcl;
      CFArrayRef applications = NULL;
      CFStringRef description = NULL;
      SecKeychainPromptSelector prompt = 0;
      if (SecACLCopyContents(acl, &applications, &description, &prompt) != errSecSuccess) {
        CFRelease(aclList);
        return fail();
      }
      if (applications == NULL) allowAll = YES;
      CFIndex appCount = applications == NULL ? 0 : CFArrayGetCount(applications);
      trustedCount += appCount;
      NSMutableArray<NSString *> *applicationFingerprints = [NSMutableArray array];
      for (CFIndex appIndex = 0; appIndex < appCount; appIndex++) {
        SecTrustedApplicationRef application = (SecTrustedApplicationRef)CFArrayGetValueAtIndex(
          applications,
          appIndex
        );
        CFDataRef applicationData = NULL;
        if (application == NULL || SecTrustedApplicationCopyData(application, &applicationData) != errSecSuccess ||
            applicationData == NULL) {
          if (applicationData != NULL) CFRelease(applicationData);
          if (applications != NULL) CFRelease(applications);
          if (description != NULL) CFRelease(description);
          CFRelease(aclList);
          return fail();
        }
        unsigned char appDigest[CC_SHA256_DIGEST_LENGTH];
        CC_SHA256(CFDataGetBytePtr(applicationData), (CC_LONG)CFDataGetLength(applicationData), appDigest);
        CFRelease(applicationData);
        NSMutableString *appFingerprint = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
        for (NSUInteger digestIndex = 0; digestIndex < CC_SHA256_DIGEST_LENGTH; digestIndex++) {
          [appFingerprint appendFormat:@"%02x", appDigest[digestIndex]];
        }
        [applicationFingerprints addObject:appFingerprint];
      }
      [applicationFingerprints sortUsingSelector:@selector(compare:)];

      CFArrayRef authorizations = SecACLCopyAuthorizations(acl);
      if (authorizations == NULL) {
        if (applications != NULL) CFRelease(applications);
        if (description != NULL) CFRelease(description);
        CFRelease(aclList);
        return fail();
      }
      NSArray<NSString *> *authStrings = [(__bridge NSArray *)authorizations
        sortedArrayUsingSelector:@selector(compare:)];
      authorizationCount += authStrings.count;
      NSString *descriptionString = description == NULL ? @"" : [(__bridge NSString *)description copy];
      NSDictionary *aclProjection = @{
        @"applications": applicationFingerprints,
        @"authorizations": authStrings,
        @"description": descriptionString,
        @"prompt": @((unsigned int)prompt),
      };
      NSData *aclData = [NSJSONSerialization dataWithJSONObject:aclProjection
                                                        options:NSJSONWritingSortedKeys
                                                          error:nil];
      if (aclData == nil) {
        CFRelease(authorizations);
        if (applications != NULL) CFRelease(applications);
        if (description != NULL) CFRelease(description);
        CFRelease(aclList);
        return fail();
      }
      [canonical addObject:[aclData base64EncodedStringWithOptions:0]];
      CFRelease(authorizations);
      if (applications != NULL) CFRelease(applications);
      if (description != NULL) CFRelease(description);
    }
    CFRelease(aclList);
    [canonical sortUsingSelector:@selector(compare:)];
    NSData *canonicalData = [NSJSONSerialization dataWithJSONObject:canonical
                                                            options:0
                                                              error:nil];
    if (canonicalData == nil) return fail();
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256(canonicalData.bytes, (CC_LONG)canonicalData.length, digest);
    NSMutableString *fingerprint = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
    for (NSUInteger index = 0; index < CC_SHA256_DIGEST_LENGTH; index++) {
      [fingerprint appendFormat:@"%02x", digest[index]];
    }
    NSDictionary *result = @{
      @"found": @YES,
      @"allowAllApplications": @(allowAll),
      @"trustedApplicationCount": @(trustedCount),
      @"authorizationCount": @(authorizationCount),
      @"fingerprint": fingerprint,
    };
    NSData *json = [NSJSONSerialization dataWithJSONObject:result options:NSJSONWritingSortedKeys error:nil];
    if (json == nil) return fail();
    NSFileHandle *standardOutput = [NSFileHandle fileHandleWithStandardOutput];
    [standardOutput writeData:json];
    [standardOutput writeData:[@"\n" dataUsingEncoding:NSUTF8StringEncoding]];
    return 0;
  }
}
