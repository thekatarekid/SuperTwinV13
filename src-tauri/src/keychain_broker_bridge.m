#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <CommonCrypto/CommonDigest.h>
#import <Security/Security.h>

static NSString *const Service = @"SuperTwinV13 ChatGPT OAuth";
static const NSUInteger MaxInput = 128 * 1024;
static const NSUInteger MaxOutput = 256 * 1024;

static BOOL exact(NSString *value, NSString *pattern) {
  if (!value) return NO;
  NSRegularExpression *regex = [NSRegularExpression regularExpressionWithPattern:pattern options:0 error:nil];
  NSTextCheckingResult *match = [regex firstMatchInString:value options:0 range:NSMakeRange(0, value.length)];
  return match && NSEqualRanges(match.range, NSMakeRange(0, value.length));
}

static int mapped(OSStatus status) {
  if (status == errSecSuccess) return 0;
  if (status == errSecItemNotFound) return 44;
  if (status == errSecDuplicateItem) return 45;
  return 1;
}

static NSData *decodeRef(NSString *value) {
  if (!value || value.length == 0 || value.length > 8192 ||
      !exact(value, @"[A-Za-z0-9_-]{1,8192}")) return nil;
  NSString *base64 = [[value stringByReplacingOccurrencesOfString:@"-" withString:@"+"]
    stringByReplacingOccurrencesOfString:@"_" withString:@"/"];
  NSUInteger padding = (4 - base64.length % 4) % 4;
  base64 = [base64 stringByPaddingToLength:base64.length + padding withString:@"=" startingAtIndex:0];
  return [[NSData alloc] initWithBase64EncodedString:base64 options:0];
}

static NSString *encodeRef(NSData *value) {
  if (!value || value.length == 0 || value.length > 4096) return nil;
  NSString *encoded = [value base64EncodedStringWithOptions:0];
  encoded = [[encoded stringByReplacingOccurrencesOfString:@"+" withString:@"-"]
    stringByReplacingOccurrencesOfString:@"/" withString:@"_"];
  while ([encoded hasSuffix:@"="]) encoded = [encoded substringToIndex:encoded.length - 1];
  return encoded;
}

static int copyOutput(NSData *data, uint8_t **output, size_t *outputLength) {
  if (!output || !outputLength || data.length > MaxOutput) return 65;
  *output = NULL;
  *outputLength = 0;
  if (data.length == 0) return 0;
  void *copy = calloc(1, data.length);
  if (!copy) return 1;
  memcpy(copy, data.bytes, data.length);
  *output = copy;
  *outputLength = data.length;
  return 0;
}

static int matchFrame(NSDictionary *match, NSString *account, NSString *label,
                      uint8_t **output, size_t *outputLength) {
  NSData *value = match[(__bridge id)kSecValueData];
  NSData *persistent = match[(__bridge id)kSecValuePersistentRef];
  NSString *actualService = match[(__bridge id)kSecAttrService];
  NSString *actualAccount = match[(__bridge id)kSecAttrAccount];
  NSString *actualLabel = match[(__bridge id)kSecAttrLabel];
  NSString *encoded = encodeRef(persistent);
  if (!value || value.length > MaxInput || !encoded || ![actualService isEqualToString:Service] ||
      ![actualAccount isEqualToString:account] || ![actualLabel isEqualToString:label]) return 66;
  NSDictionary *frame = @{ @"service": actualService, @"account": actualAccount, @"label": actualLabel,
    @"persistent_ref": encoded, @"value_base64": [value base64EncodedStringWithOptions:0] };
  NSData *json = [NSJSONSerialization dataWithJSONObject:frame options:0 error:nil];
  return json ? copyOutput(json, output, outputLength) : 65;
}

static NSString *sha256Hex(NSData *data) {
  if (!data || data.length > UINT32_MAX) return nil;
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
  NSMutableString *hex = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
  for (NSUInteger index = 0; index < CC_SHA256_DIGEST_LENGTH; index++) {
    [hex appendFormat:@"%02x", digest[index]];
  }
  return hex;
}

static int aclSnapshot(SecKeychainItemRef item, uint8_t **output, size_t *outputLength) {
  if (!item) return 65;
  SecAccessRef access = NULL;
  if (SecKeychainItemCopyAccess(item, &access) != errSecSuccess || !access) return 1;
  CFArrayRef aclList = NULL;
  OSStatus status = SecAccessCopyACLList(access, &aclList);
  CFRelease(access);
  if (status != errSecSuccess || !aclList) return mapped(status);

  BOOL allowAll = NO;
  NSUInteger trustedCount = 0;
  NSUInteger authorizationCount = 0;
  NSMutableArray<NSString *> *canonical = [NSMutableArray array];
  for (id rawAcl in (__bridge NSArray *)aclList) {
    SecACLRef acl = (__bridge SecACLRef)rawAcl;
    CFArrayRef applications = NULL;
    CFStringRef description = NULL;
    SecKeychainPromptSelector prompt = 0;
    if (SecACLCopyContents(acl, &applications, &description, &prompt) != errSecSuccess) {
      if (applications) CFRelease(applications);
      if (description) CFRelease(description);
      CFRelease(aclList);
      return 1;
    }
    if (!applications) allowAll = YES;
    CFIndex applicationCount = applications ? CFArrayGetCount(applications) : 0;
    if (applicationCount < 0 || (NSUInteger)applicationCount > 4096 - MIN(trustedCount, (NSUInteger)4096)) {
      if (applications) CFRelease(applications);
      if (description) CFRelease(description);
      CFRelease(aclList);
      return 65;
    }
    trustedCount += (NSUInteger)applicationCount;
    NSMutableArray<NSString *> *applicationFingerprints = [NSMutableArray array];
    for (CFIndex index = 0; index < applicationCount; index++) {
      SecTrustedApplicationRef application =
        (SecTrustedApplicationRef)CFArrayGetValueAtIndex(applications, index);
      CFDataRef applicationData = NULL;
      if (!application || SecTrustedApplicationCopyData(application, &applicationData) != errSecSuccess ||
          !applicationData) {
        if (applicationData) CFRelease(applicationData);
        if (applications) CFRelease(applications);
        if (description) CFRelease(description);
        CFRelease(aclList);
        return 1;
      }
      NSString *fingerprint = sha256Hex((__bridge NSData *)applicationData);
      CFRelease(applicationData);
      if (!fingerprint) {
        if (applications) CFRelease(applications);
        if (description) CFRelease(description);
        CFRelease(aclList);
        return 65;
      }
      [applicationFingerprints addObject:fingerprint];
    }
    [applicationFingerprints sortUsingSelector:@selector(compare:)];

    CFArrayRef authorizations = SecACLCopyAuthorizations(acl);
    if (!authorizations) {
      if (applications) CFRelease(applications);
      if (description) CFRelease(description);
      CFRelease(aclList);
      return 1;
    }
    NSArray<NSString *> *authorizationStrings =
      [(__bridge NSArray *)authorizations sortedArrayUsingSelector:@selector(compare:)];
    if (authorizationStrings.count > 4096 - MIN(authorizationCount, (NSUInteger)4096)) {
      CFRelease(authorizations);
      if (applications) CFRelease(applications);
      if (description) CFRelease(description);
      CFRelease(aclList);
      return 65;
    }
    authorizationCount += authorizationStrings.count;
    NSDictionary *projection = @{ @"applications": applicationFingerprints,
      @"authorizations": authorizationStrings,
      @"description": description ? (__bridge NSString *)description : @"",
      @"prompt": @((unsigned int)prompt) };
    NSData *projectionData = [NSJSONSerialization dataWithJSONObject:projection
      options:NSJSONWritingSortedKeys error:nil];
    if (!projectionData) {
      CFRelease(authorizations);
      if (applications) CFRelease(applications);
      if (description) CFRelease(description);
      CFRelease(aclList);
      return 65;
    }
    [canonical addObject:[projectionData base64EncodedStringWithOptions:0]];
    CFRelease(authorizations);
    if (applications) CFRelease(applications);
    if (description) CFRelease(description);
  }
  CFRelease(aclList);
  [canonical sortUsingSelector:@selector(compare:)];
  NSData *canonicalData = [NSJSONSerialization dataWithJSONObject:canonical options:0 error:nil];
  NSString *fingerprint = sha256Hex(canonicalData);
  if (!fingerprint) return 65;
  NSDictionary *snapshot = @{ @"found": @YES, @"allowAllApplications": @(allowAll),
    @"trustedApplicationCount": @(trustedCount), @"authorizationCount": @(authorizationCount),
    @"fingerprint": fingerprint };
  NSData *json = [NSJSONSerialization dataWithJSONObject:snapshot options:NSJSONWritingSortedKeys error:nil];
  return json ? copyOutput(json, output, outputLength) : 65;
}

// Called only inside the signed Tauri process. The stdio broker validates the
// request and derives the account before crossing this ABI.
int supertwin_keychain_execute(const char *operationBytes, const char *accountBytes,
                               const char *labelBytes, const char *persistentRefBytes,
                               const uint8_t *inputBytes, size_t inputLength,
                               uint8_t **output, size_t *outputLength) {
  @autoreleasepool {
    if (!operationBytes || !accountBytes || !output || !outputLength || inputLength > MaxInput) return 64;
    *output = NULL; *outputLength = 0;
    NSString *operation = [NSString stringWithUTF8String:operationBytes];
    NSString *account = [NSString stringWithUTF8String:accountBytes];
    NSString *label = labelBytes ? [NSString stringWithUTF8String:labelBytes] : nil;
    NSString *persistentRefText = persistentRefBytes ? [NSString stringWithUTF8String:persistentRefBytes] : nil;
    NSSet<NSString *> *allowed = [NSSet setWithArray:@[@"exists", @"read", @"upsert", @"delete",
      @"create", @"lookup-owned", @"read-ref", @"update-owned-ref", @"delete-owned-ref",
      @"acl-owned-ref"]];
    if (![allowed containsObject:operation] ||
        !exact(account, @"supertwin\\.chatgpt-oauth\\.[a-f0-9]{16}") ||
        (label && !exact(label, @"SuperTwinV13 golden [a-f0-9]{32}"))) return 64;
    NSMutableDictionary *query = [@{(__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
      (__bridge id)kSecAttrService: Service, (__bridge id)kSecAttrAccount: account,
      (__bridge id)kSecUseAuthenticationUI: (__bridge id)kSecUseAuthenticationUIFail} mutableCopy];
    if (label) query[(__bridge id)kSecAttrLabel] = label;
    int result = 64;
    if ([operation isEqualToString:@"exists"]) {
      query[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
      result = mapped(SecItemCopyMatching((__bridge CFDictionaryRef)query, NULL));
    } else if ([operation isEqualToString:@"read"]) {
      query[(__bridge id)kSecReturnData] = @YES;
      query[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
      CFTypeRef found = NULL;
      OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &found);
      if (status == errSecSuccess) {
        NSData *data = CFBridgingRelease(found);
        result = data.length <= MaxInput ? copyOutput(data, output, outputLength) : 65;
      } else result = mapped(status);
    } else if ([operation isEqualToString:@"upsert"]) {
      if (!inputBytes || inputLength == 0) result = 65;
      else {
        NSData *input = [NSData dataWithBytes:inputBytes length:inputLength];
        OSStatus status = SecItemUpdate((__bridge CFDictionaryRef)query,
          (__bridge CFDictionaryRef)@{(__bridge id)kSecValueData: input});
        if (status == errSecItemNotFound) {
          query[(__bridge id)kSecValueData] = input;
          status = SecItemAdd((__bridge CFDictionaryRef)query, NULL);
          if (status == errSecDuplicateItem) status = SecItemUpdate((__bridge CFDictionaryRef)query,
            (__bridge CFDictionaryRef)@{(__bridge id)kSecValueData: input});
        }
        result = mapped(status);
      }
    } else if ([operation isEqualToString:@"delete"]) {
      result = mapped(SecItemDelete((__bridge CFDictionaryRef)query));
    } else if ([operation isEqualToString:@"create"]) {
      if (!label || !inputBytes || inputLength == 0) result = 65;
      else {
        NSData *input = [NSData dataWithBytes:inputBytes length:inputLength];
        query[(__bridge id)kSecValueData] = input;
        query[(__bridge id)kSecReturnPersistentRef] = @YES;
        CFTypeRef created = NULL;
        OSStatus status = SecItemAdd((__bridge CFDictionaryRef)query, &created);
        if (status == errSecSuccess) {
          NSData *persistent = CFBridgingRelease(created);
          NSString *encoded = encodeRef(persistent);
          result = encoded ? copyOutput([encoded dataUsingEncoding:NSUTF8StringEncoding], output, outputLength) : 65;
        } else result = mapped(status);
      }
    } else if ([operation isEqualToString:@"acl-owned-ref"]) {
      NSData *persistent = decodeRef(persistentRefText);
      if (!label || !persistent || inputLength != 0) result = 64;
      else {
        NSDictionary *attributesQuery = @{ (__bridge id)kSecValuePersistentRef: persistent,
          (__bridge id)kSecReturnAttributes: @YES, (__bridge id)kSecReturnPersistentRef: @YES,
          (__bridge id)kSecMatchLimit: (__bridge id)kSecMatchLimitOne,
          (__bridge id)kSecUseAuthenticationUI: (__bridge id)kSecUseAuthenticationUIFail };
        CFTypeRef foundAttributes = NULL;
        OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)attributesQuery, &foundAttributes);
        if (status != errSecSuccess) result = mapped(status);
        else {
          NSDictionary *attributes = CFBridgingRelease(foundAttributes);
          NSData *actualRef = attributes[(__bridge id)kSecValuePersistentRef];
          NSString *actualService = attributes[(__bridge id)kSecAttrService];
          NSString *actualAccount = attributes[(__bridge id)kSecAttrAccount];
          NSString *actualLabel = attributes[(__bridge id)kSecAttrLabel];
          if (![actualRef isEqualToData:persistent] || ![actualService isEqualToString:Service] ||
              ![actualAccount isEqualToString:account] || ![actualLabel isEqualToString:label]) result = 66;
          else {
            NSDictionary *itemQuery = @{ (__bridge id)kSecValuePersistentRef: persistent,
              (__bridge id)kSecReturnRef: @YES,
              (__bridge id)kSecMatchLimit: (__bridge id)kSecMatchLimitOne,
              (__bridge id)kSecUseAuthenticationUI: (__bridge id)kSecUseAuthenticationUIFail };
            CFTypeRef foundItem = NULL;
            status = SecItemCopyMatching((__bridge CFDictionaryRef)itemQuery, &foundItem);
            if (status != errSecSuccess) result = mapped(status);
            else if (!foundItem || CFGetTypeID(foundItem) != SecKeychainItemGetTypeID()) result = 66;
            else result = aclSnapshot((SecKeychainItemRef)foundItem, output, outputLength);
            if (foundItem) CFRelease(foundItem);
          }
        }
      }
    } else if ([operation isEqualToString:@"lookup-owned"] || [operation isEqualToString:@"read-ref"] ||
               [operation isEqualToString:@"update-owned-ref"] ||
               [operation isEqualToString:@"delete-owned-ref"]) {
      NSData *persistent = [operation isEqualToString:@"lookup-owned"] ? nil : decodeRef(persistentRefText);
      if (!label || (![operation isEqualToString:@"lookup-owned"] && !persistent)) result = 64;
      else {
        NSDictionary *matchQuery = persistent ? @{(__bridge id)kSecValuePersistentRef: persistent,
          (__bridge id)kSecReturnAttributes: @YES, (__bridge id)kSecReturnData: @YES,
          (__bridge id)kSecReturnPersistentRef: @YES, (__bridge id)kSecMatchLimit: (__bridge id)kSecMatchLimitOne,
          (__bridge id)kSecUseAuthenticationUI: (__bridge id)kSecUseAuthenticationUIFail} :
          @{(__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
            (__bridge id)kSecAttrService: Service, (__bridge id)kSecAttrAccount: account,
            (__bridge id)kSecAttrLabel: label, (__bridge id)kSecReturnAttributes: @YES,
            (__bridge id)kSecReturnData: @YES, (__bridge id)kSecReturnPersistentRef: @YES,
            (__bridge id)kSecMatchLimit: (__bridge id)kSecMatchLimitOne,
            (__bridge id)kSecUseAuthenticationUI: (__bridge id)kSecUseAuthenticationUIFail};
        CFTypeRef found = NULL;
        OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)matchQuery, &found);
        if (status != errSecSuccess) result = mapped(status);
        else {
          NSDictionary *match = CFBridgingRelease(found);
          if ([operation isEqualToString:@"lookup-owned"] || [operation isEqualToString:@"read-ref"]) {
            result = matchFrame(match, account, label, output, outputLength);
          } else if ([operation isEqualToString:@"update-owned-ref"]) {
            NSData *actualRef = match[(__bridge id)kSecValuePersistentRef];
            NSString *actualService = match[(__bridge id)kSecAttrService];
            NSString *actualAccount = match[(__bridge id)kSecAttrAccount];
            NSString *actualLabel = match[(__bridge id)kSecAttrLabel];
            NSData *input = inputBytes && inputLength > 0 ? [NSData dataWithBytes:inputBytes length:inputLength] : nil;
            if (!input || ![actualService isEqualToString:Service] ||
                ![actualAccount isEqualToString:account] || ![actualLabel isEqualToString:label] ||
                ![actualRef isEqualToData:persistent]) result = 66;
            else result = mapped(SecItemUpdate((__bridge CFDictionaryRef)@{
              (__bridge id)kSecValuePersistentRef: persistent,
              (__bridge id)kSecUseAuthenticationUI: (__bridge id)kSecUseAuthenticationUIFail},
              (__bridge CFDictionaryRef)@{(__bridge id)kSecValueData: input}));
          } else {
            NSData *value = match[(__bridge id)kSecValueData];
            NSData *actualRef = match[(__bridge id)kSecValuePersistentRef];
            NSString *actualService = match[(__bridge id)kSecAttrService];
            NSString *actualAccount = match[(__bridge id)kSecAttrAccount];
            NSString *actualLabel = match[(__bridge id)kSecAttrLabel];
            NSData *expectedData = inputBytes ? [NSData dataWithBytes:inputBytes length:inputLength] : nil;
            NSString *expectedAccountId = expectedData ? [[NSString alloc] initWithData:expectedData encoding:NSUTF8StringEncoding] : nil;
            NSDictionary *envelope = value ? [NSJSONSerialization JSONObjectWithData:value options:0 error:nil] : nil;
            NSDictionary *current = [envelope isKindOfClass:NSDictionary.class] ? envelope[@"current"] : nil;
            NSString *actualAccountId = [current isKindOfClass:NSDictionary.class] ? current[@"accountId"] : nil;
            if (![envelope[@"version"] isEqual:@1] || ![actualService isEqualToString:Service] ||
                ![actualAccount isEqualToString:account] || ![actualLabel isEqualToString:label] ||
                ![actualRef isEqualToData:persistent] || !expectedAccountId ||
                ![actualAccountId isEqualToString:expectedAccountId]) result = 66;
            else result = mapped(SecItemDelete((__bridge CFDictionaryRef)@{
              (__bridge id)kSecValuePersistentRef: persistent,
              (__bridge id)kSecUseAuthenticationUI: (__bridge id)kSecUseAuthenticationUIFail}));
          }
        }
      }
    }
    return result;
  }
}

void supertwin_keychain_free(void *pointer) {
  if (pointer) free(pointer);
}

// Startup-only signed golden gate. No WebView exists when this is called.
int supertwin_signed_app_valid(const char *pathBytes, const char *teamBytes) {
  @autoreleasepool {
    if (!pathBytes || !teamBytes) return 0;
    NSString *path = [NSString stringWithUTF8String:pathBytes];
    NSString *team = [NSString stringWithUTF8String:teamBytes];
    NSCharacterSet *allowed = [NSCharacterSet characterSetWithCharactersInString:@"ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"];
    if (!path || ![path.pathExtension isEqualToString:@"app"] || team.length != 10 ||
        [team rangeOfCharacterFromSet:allowed.invertedSet].location != NSNotFound) return 0;
    SecStaticCodeRef code = NULL;
    SecRequirementRef requirement = NULL;
    OSStatus created = SecStaticCodeCreateWithPath((__bridge CFURLRef)[NSURL fileURLWithPath:path],
      kSecCSDefaultFlags, &code);
    NSString *requirementText = [NSString stringWithFormat:
      @"anchor apple generic and identifier \"com.supertwin.v13\" and certificate leaf[subject.OU] = \"%@\" and certificate 1[field.1.2.840.113635.100.6.1.13] exists", team];
    OSStatus required = SecRequirementCreateWithString(
      (__bridge CFStringRef)requirementText, kSecCSDefaultFlags, &requirement);
    OSStatus valid = (created == errSecSuccess && required == errSecSuccess)
      ? SecStaticCodeCheckValidity(code, kSecCSCheckAllArchitectures | kSecCSStrictValidate, requirement) : errSecParam;
    if (requirement) CFRelease(requirement);
    if (code) CFRelease(code);
    return valid == errSecSuccess ? 1 : 0;
  }
}

int supertwin_native_verification_app_valid(const char *pathBytes) {
  @autoreleasepool {
    if (!pathBytes) return 0;
    NSString *path = [NSString stringWithUTF8String:pathBytes];
    if (!path || ![path.pathExtension isEqualToString:@"app"]) return 0;
    SecStaticCodeRef code = NULL;
    SecRequirementRef requirement = NULL;
    OSStatus created = SecStaticCodeCreateWithPath((__bridge CFURLRef)[NSURL fileURLWithPath:path],
      kSecCSDefaultFlags, &code);
    OSStatus required = SecRequirementCreateWithString(CFSTR("identifier \"com.supertwin.v13\""),
      kSecCSDefaultFlags, &requirement);
    OSStatus valid = (created == errSecSuccess && required == errSecSuccess)
      ? SecStaticCodeCheckValidity(code, kSecCSCheckAllArchitectures | kSecCSStrictValidate, requirement) : errSecParam;
    if (requirement) CFRelease(requirement);
    if (code) CFRelease(code);
    return valid == errSecSuccess ? 1 : 0;
  }
}

int supertwin_confirm_native_verification(const uint8_t *bytes, size_t length) {
  @autoreleasepool {
    if (!bytes || length == 0 || length > 128 * 1024) return 0;
    NSString *declaration = [[NSString alloc] initWithBytes:bytes length:length encoding:NSUTF8StringEncoding];
    if (!declaration) return 0;
    [NSApplication sharedApplication];
    [NSApp activateIgnoringOtherApps:YES];
    NSAlert *alert = [[NSAlert alloc] init];
    alert.alertStyle = NSAlertStyleCritical;
    alert.messageText = @"Authorize isolated native Keychain verification?";
    alert.informativeText = declaration;
    [alert addButtonWithTitle:@"Authorize exact dummy-only operation"];
    [alert addButtonWithTitle:@"Cancel"];
    return [alert runModal] == NSAlertFirstButtonReturn ? 1 : 0;
  }
}

int supertwin_confirm_golden(const uint8_t *bytes, size_t length) {
  @autoreleasepool {
    if (!bytes || length == 0 || length > 128 * 1024) return 0;
    NSString *declaration = [[NSString alloc] initWithBytes:bytes length:length encoding:NSUTF8StringEncoding];
    if (!declaration) return 0;
    [NSApplication sharedApplication];
    [NSApp activateIgnoringOtherApps:YES];
    NSAlert *alert = [[NSAlert alloc] init];
    alert.alertStyle = NSAlertStyleCritical;
    alert.messageText = @"Authorize SuperTwin provider golden operation?";
    alert.informativeText = declaration;
    [alert addButtonWithTitle:@"Authorize exact declaration"];
    [alert addButtonWithTitle:@"Cancel"];
    return [alert runModal] == NSAlertFirstButtonReturn ? 1 : 0;
  }
}
