// SMB shares are mounted by macOS itself (NetFS, as Finder does), at a folder Cove owns, so the
// rest of the app reads them like a local disk.
#import <Foundation/Foundation.h>
#import <NetFS/NetFS.h>
#include <errno.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/param.h>

/// 1 when an SMB share is mounted exactly at `path`.
int nimbus_smb_mounted_at(const char *path) {
    struct statfs info;
    if (statfs(path, &info) != 0) return 0;
    return strcmp(info.f_fstypename, "smbfs") == 0 && strcmp(info.f_mntonname, path) == 0;
}

/// Mount `url` (smb://host/share) at `mountpath`, never showing a dialog. An empty user signs in as
/// guest. Returns 0, or the error NetFS reports (an errno value or a NetAuth code).
int nimbus_smb_mount(const char *url, const char *mountpath, const char *user, const char *password) {
    @autoreleasepool {
        NSURL *share = [NSURL URLWithString:[NSString stringWithUTF8String:url]];
        NSURL *mount = [NSURL fileURLWithPath:[NSString stringWithUTF8String:mountpath] isDirectory:YES];
        if (!share || !mount) return EINVAL;
        BOOL guest = !user || !*user;
        NSMutableDictionary *open = [NSMutableDictionary dictionary];
        open[(__bridge NSString *)kNAUIOptionKey] = (__bridge NSString *)kNAUIOptionNoUI;
        if (guest) open[(__bridge NSString *)kNetFSUseGuestKey] = @YES;
        NSMutableDictionary *options = [NSMutableDictionary dictionary];
        options[(__bridge NSString *)kNetFSMountAtMountDirKey] = @YES;
        options[(__bridge NSString *)kNetFSSoftMountKey] = @YES;
        NSString *name = guest ? nil : [NSString stringWithUTF8String:user];
        NSString *secret = (!guest && password) ? [NSString stringWithUTF8String:password] : nil;
        CFArrayRef points = NULL;
        int result = NetFSMountURLSync((__bridge CFURLRef)share, (__bridge CFURLRef)mount,
                                       (__bridge CFStringRef)name, (__bridge CFStringRef)secret,
                                       (__bridge CFMutableDictionaryRef)open,
                                       (__bridge CFMutableDictionaryRef)options, &points);
        if (points) CFRelease(points);
        return result;
    }
}

/// Unmount the share at `path`; 0 on success, else errno.
int nimbus_smb_unmount(const char *path) {
    return unmount(path, MNT_FORCE) == 0 ? 0 : errno;
}

/// When `host`/`share` is already mounted (by Finder, say), copy its mount point into `out` and
/// return 1. macOS does not mount one share twice for the same user.
int nimbus_smb_find_mount(const char *host, const char *share, char *out, size_t length) {
    @autoreleasepool {
        NSString *wantedHost = [NSString stringWithUTF8String:host];
        NSString *wantedShare = [NSString stringWithUTF8String:share];
        struct statfs *mounts = NULL;
        int count = getmntinfo(&mounts, MNT_NOWAIT);
        for (int index = 0; index < count; index++) {
            if (strcmp(mounts[index].f_fstypename, "smbfs") != 0) continue;
            // "//user@host/share" or "//host:port/share", the share percent-encoded.
            NSString *from = [NSString stringWithUTF8String:mounts[index].f_mntfromname];
            if ([from hasPrefix:@"//"]) from = [from substringFromIndex:2];
            NSRange at = [from rangeOfString:@"@" options:NSBackwardsSearch];
            if (at.location != NSNotFound) from = [from substringFromIndex:at.location + 1];
            NSRange slash = [from rangeOfString:@"/"];
            if (slash.location == NSNotFound) continue;
            NSString *mountedHost = [[from substringToIndex:slash.location] componentsSeparatedByString:@":"].firstObject;
            NSString *mountedShare = [from substringFromIndex:slash.location + 1];
            mountedShare = [mountedShare stringByRemovingPercentEncoding] ?: mountedShare;
            if ([mountedHost caseInsensitiveCompare:wantedHost] == NSOrderedSame &&
                [mountedShare caseInsensitiveCompare:wantedShare] == NSOrderedSame) {
                strlcpy(out, mounts[index].f_mntonname, length);
                return 1;
            }
        }
        return 0;
    }
}
