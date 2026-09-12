#define GL_SILENCE_DEPRECATION
#import <Cocoa/Cocoa.h>
#import <OpenGL/gl.h>
#import <mpv/client.h>
#import <mpv/render_gl.h>

@interface NimbusMpvOpenGLView : NSOpenGLView
@property(nonatomic, assign) mpv_render_context *mpvGL;
@end

static void *nimbus_get_proc_address(void *context, const char *name) {
    (void)context;
    CFStringRef symbol = CFStringCreateWithCString(kCFAllocatorDefault, name, kCFStringEncodingASCII);
    void *address = CFBundleGetFunctionPointerForName(
        CFBundleGetBundleWithIdentifier(CFSTR("com.apple.opengl")), symbol);
    CFRelease(symbol);
    return address;
}

static void nimbus_mpv_update(void *context) {
    NimbusMpvOpenGLView *view = (__bridge NimbusMpvOpenGLView *)context;
    dispatch_async(dispatch_get_main_queue(), ^{
        [view setNeedsDisplay:YES];
    });
}

@implementation NimbusMpvOpenGLView

- (NSView *)hitTest:(NSPoint)point {
    (void)point;
    return nil;
}

- (instancetype)initWithFrame:(NSRect)frame {
    NSOpenGLPixelFormatAttribute attributes[] = {
        NSOpenGLPFADoubleBuffer,
        NSOpenGLPFAAccelerated,
        0,
    };
    NSOpenGLPixelFormat *format = [[NSOpenGLPixelFormat alloc] initWithAttributes:attributes];
    self = [super initWithFrame:frame pixelFormat:format];
    if (self) {
        self.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
        self.wantsBestResolutionOpenGLSurface = YES;
        self.mpvGL = NULL;
        GLint swapInterval = 1;
        [self.openGLContext setValues:&swapInterval forParameter:NSOpenGLContextParameterSwapInterval];
    }
    return self;
}

- (void)drawRect:(NSRect)dirtyRect {
    [self.openGLContext makeCurrentContext];
    NSRect backing = [self convertRectToBacking:self.bounds];
    if (self.mpvGL) {
        mpv_opengl_fbo fbo = {
            .fbo = 0,
            .w = (int)backing.size.width,
            .h = (int)backing.size.height,
            .internal_format = 0,
        };
        int flip = 1;
        mpv_render_param params[] = {
            {MPV_RENDER_PARAM_OPENGL_FBO, &fbo},
            {MPV_RENDER_PARAM_FLIP_Y, &flip},
            {MPV_RENDER_PARAM_INVALID, NULL},
        };
        mpv_render_context_render(self.mpvGL, params);
    } else {
        glClearColor(0, 0, 0, 1);
        glClear(GL_COLOR_BUFFER_BIT);
    }
    [self.openGLContext flushBuffer];
}

@end

void *nimbus_mpv_view_create(void *window_pointer, double controls_height) {
    NSWindow *window = (__bridge NSWindow *)window_pointer;
    NSView *content = window.contentView;
    NSRect bounds = content.bounds;
    NSRect frame = NSMakeRect(0, controls_height, bounds.size.width,
                              MAX(1, bounds.size.height - controls_height));
    NimbusMpvOpenGLView *view = [[NimbusMpvOpenGLView alloc] initWithFrame:frame];
    [content addSubview:view];
    return (__bridge void *)view;
}

int nimbus_mpv_view_attach(void *view_pointer, mpv_handle *mpv) {
    __block int result = 0;
    void (^attach)(void) = ^{
        NimbusMpvOpenGLView *view = (__bridge NimbusMpvOpenGLView *)view_pointer;
        [view.openGLContext makeCurrentContext];
        result = mpv_set_option_string(mpv, "vo", "libmpv");
        if (result < 0) return;
        mpv_opengl_init_params gl = {
            .get_proc_address = nimbus_get_proc_address,
            .get_proc_address_ctx = NULL,
        };
        const char *api = MPV_RENDER_API_TYPE_OPENGL;
        mpv_render_param params[] = {
            {MPV_RENDER_PARAM_API_TYPE, (void *)api},
            {MPV_RENDER_PARAM_OPENGL_INIT_PARAMS, &gl},
            {MPV_RENDER_PARAM_INVALID, NULL},
        };
        mpv_render_context *render_context = NULL;
        result = mpv_render_context_create(&render_context, mpv, params);
        if (result >= 0) {
            view.mpvGL = render_context;
            mpv_render_context_set_update_callback(view.mpvGL, nimbus_mpv_update,
                                                   (__bridge void *)view);
            [view setNeedsDisplay:YES];
        }
    };
    if (NSThread.isMainThread) attach();
    else dispatch_sync(dispatch_get_main_queue(), attach);
    return result;
}

void nimbus_mpv_view_set_hidden(void *view_pointer, bool hidden) {
    void (^update)(void) = ^{
        NimbusMpvOpenGLView *view = (__bridge NimbusMpvOpenGLView *)view_pointer;
        view.hidden = hidden;
    };
    if (NSThread.isMainThread) update();
    else dispatch_async(dispatch_get_main_queue(), update);
}

void nimbus_mpv_view_set_controls_height(void *view_pointer, double controls_height) {
    void (^update)(void) = ^{
        NimbusMpvOpenGLView *view = (__bridge NimbusMpvOpenGLView *)view_pointer;
        NSRect bounds = view.superview.bounds;
        view.frame = NSMakeRect(0, controls_height, bounds.size.width,
                                MAX(1, bounds.size.height - controls_height));
    };
    if (NSThread.isMainThread) update();
    else dispatch_async(dispatch_get_main_queue(), update);
}

void nimbus_attach_controls_window(void *parent_pointer, void *child_pointer) {
    void (^attach)(void) = ^{
        NSWindow *parent = (__bridge NSWindow *)parent_pointer;
        NSWindow *child = (__bridge NSWindow *)child_pointer;
        // Keep the overlay strictly below native traffic lights; transparent windows still hit-test.
        NSRect parentFrame = parent.frame;
        CGFloat titlebarHeight = 52.0;
        NSRect childFrame = NSMakeRect(parentFrame.origin.x,
                                       parentFrame.origin.y,
                                       parentFrame.size.width,
                                       MAX(1.0, parentFrame.size.height - titlebarHeight));
        [child setFrame:childFrame display:YES];
        if (child.parentWindow != parent) {
            if (child.parentWindow) [child.parentWindow removeChildWindow:child];
            [parent addChildWindow:child ordered:NSWindowAbove];
        }
    };
    if (NSThread.isMainThread) attach();
    else dispatch_async(dispatch_get_main_queue(), attach);
}

void nimbus_detach_controls_window(void *child_pointer) {
    void (^detach)(void) = ^{
        NSWindow *child = (__bridge NSWindow *)child_pointer;
        if (child.parentWindow) [child.parentWindow removeChildWindow:child];
    };
    if (NSThread.isMainThread) detach();
    else dispatch_async(dispatch_get_main_queue(), detach);
}

void nimbus_mpv_view_clear(void *view_pointer) {
    if (!view_pointer) return;
    void (^clear)(void) = ^{
        NimbusMpvOpenGLView *view = (__bridge NimbusMpvOpenGLView *)view_pointer;
        [view.openGLContext makeCurrentContext];
        glClearColor(0, 0, 0, 1);
        glClear(GL_COLOR_BUFFER_BIT);
        [view.openGLContext flushBuffer];
    };
    if (NSThread.isMainThread) clear();
    else dispatch_async(dispatch_get_main_queue(), clear);
}
