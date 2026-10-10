// Bridges Cove playback to the system Now Playing widget, media keys and AirPods controls.
#import <Cocoa/Cocoa.h>
#import <MediaPlayer/MediaPlayer.h>

typedef void (*CoveRemoteCallback)(int command, double value);

enum {
    CoveRemotePlay = 1,
    CoveRemotePause = 2,
    CoveRemoteToggle = 3,
    CoveRemoteNext = 4,
    CoveRemotePrevious = 5,
    CoveRemoteSeek = 6,
};

static CoveRemoteCallback cove_remote_callback = NULL;
static NSImage *cove_artwork = nil;

static void cove_on_main(void (^block)(void)) {
    if (NSThread.isMainThread) block();
    else dispatch_async(dispatch_get_main_queue(), block);
}

static MPRemoteCommandHandlerStatus cove_forward(int command, double value) {
    if (!cove_remote_callback) return MPRemoteCommandHandlerStatusCommandFailed;
    cove_remote_callback(command, value);
    return MPRemoteCommandHandlerStatusSuccess;
}

void nimbus_now_playing_install(CoveRemoteCallback callback) {
    cove_remote_callback = callback;
    cove_on_main(^{
        MPRemoteCommandCenter *center = MPRemoteCommandCenter.sharedCommandCenter;
        [center.playCommand addTargetWithHandler:^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent *event) {
            (void)event;
            return cove_forward(CoveRemotePlay, 0);
        }];
        [center.pauseCommand addTargetWithHandler:^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent *event) {
            (void)event;
            return cove_forward(CoveRemotePause, 0);
        }];
        [center.togglePlayPauseCommand addTargetWithHandler:^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent *event) {
            (void)event;
            return cove_forward(CoveRemoteToggle, 0);
        }];
        [center.nextTrackCommand addTargetWithHandler:^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent *event) {
            (void)event;
            return cove_forward(CoveRemoteNext, 0);
        }];
        [center.previousTrackCommand addTargetWithHandler:^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent *event) {
            (void)event;
            return cove_forward(CoveRemotePrevious, 0);
        }];
        [center.changePlaybackPositionCommand addTargetWithHandler:^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent *event) {
            MPChangePlaybackPositionCommandEvent *seek = (MPChangePlaybackPositionCommandEvent *)event;
            return cove_forward(CoveRemoteSeek, seek.positionTime);
        }];
        center.skipForwardCommand.enabled = NO;
        center.skipBackwardCommand.enabled = NO;
        center.playCommand.enabled = NO;
        center.pauseCommand.enabled = NO;
        center.togglePlayPauseCommand.enabled = NO;
        center.nextTrackCommand.enabled = NO;
        center.previousTrackCommand.enabled = NO;
        center.changePlaybackPositionCommand.enabled = NO;
    });
}

static void cove_set_commands_enabled(BOOL enabled) {
    MPRemoteCommandCenter *center = MPRemoteCommandCenter.sharedCommandCenter;
    center.playCommand.enabled = enabled;
    center.pauseCommand.enabled = enabled;
    center.togglePlayPauseCommand.enabled = enabled;
    center.nextTrackCommand.enabled = enabled;
    center.previousTrackCommand.enabled = enabled;
    center.changePlaybackPositionCommand.enabled = enabled;
}

static NSString *cove_string(const char *value) {
    if (!value || !value[0]) return nil;
    return [NSString stringWithUTF8String:value];
}

void nimbus_now_playing_update(const char *title, const char *artist, const char *album,
                               double duration, double elapsed, bool playing, bool video) {
    NSString *titleValue = cove_string(title) ?: @"Cove";
    NSString *artistValue = cove_string(artist);
    NSString *albumValue = cove_string(album);
    cove_on_main(^{
        NSMutableDictionary *info = [NSMutableDictionary dictionary];
        info[MPMediaItemPropertyTitle] = titleValue;
        if (artistValue) info[MPMediaItemPropertyArtist] = artistValue;
        if (albumValue) info[MPMediaItemPropertyAlbumTitle] = albumValue;
        if (duration > 0) info[MPMediaItemPropertyPlaybackDuration] = @(duration);
        info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = @(MAX(0, elapsed));
        info[MPNowPlayingInfoPropertyPlaybackRate] = @(playing ? 1.0 : 0.0);
        info[MPNowPlayingInfoPropertyMediaType] =
            @(video ? MPNowPlayingInfoMediaTypeVideo : MPNowPlayingInfoMediaTypeAudio);
        if (cove_artwork) {
            NSImage *image = cove_artwork;
            info[MPMediaItemPropertyArtwork] =
                [[MPMediaItemArtwork alloc] initWithBoundsSize:image.size
                                                requestHandler:^NSImage *(CGSize size) {
                                                    (void)size;
                                                    return image;
                                                }];
        }
        MPNowPlayingInfoCenter *center = MPNowPlayingInfoCenter.defaultCenter;
        center.nowPlayingInfo = info;
        center.playbackState = playing ? MPNowPlayingPlaybackStatePlaying : MPNowPlayingPlaybackStatePaused;
        cove_set_commands_enabled(YES);
    });
}

void nimbus_now_playing_set_artwork(const unsigned char *bytes, size_t length) {
    NSData *data = (bytes && length) ? [NSData dataWithBytes:bytes length:length] : nil;
    cove_on_main(^{
        cove_artwork = data ? [[NSImage alloc] initWithData:data] : nil;
    });
}

void nimbus_now_playing_clear(void) {
    cove_on_main(^{
        cove_artwork = nil;
        MPNowPlayingInfoCenter *center = MPNowPlayingInfoCenter.defaultCenter;
        center.nowPlayingInfo = nil;
        center.playbackState = MPNowPlayingPlaybackStateStopped;
        cove_set_commands_enabled(NO);
    });
}
