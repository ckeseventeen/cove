// Native PDF reader windows built on PDFKit, the engine behind Preview.
#import <Cocoa/Cocoa.h>
#import <PDFKit/PDFKit.h>

typedef void (*CovePdfPageCallback)(const char *key, int page, int page_count);

static CovePdfPageCallback cove_pdf_callback = NULL;
static NSMutableDictionary<NSString *, NSWindowController *> *cove_pdf_windows = nil;

@interface CovePdfWindowController : NSWindowController <NSWindowDelegate>
@property(nonatomic, copy) NSString *key;
@property(nonatomic, strong) PDFView *pdfView;
@end

@implementation CovePdfWindowController

- (void)reportPage {
    PDFDocument *document = self.pdfView.document;
    PDFPage *page = self.pdfView.currentPage;
    if (!document || !page) return;
    NSInteger index = [document indexForPage:page];
    NSInteger count = document.pageCount;
    self.window.subtitle = [NSString stringWithFormat:@"第 %ld 页，共 %ld 页", (long)index + 1, (long)count];
    if (cove_pdf_callback) cove_pdf_callback(self.key.UTF8String, (int)index, (int)count);
}

- (void)pageChanged:(NSNotification *)notification {
    (void)notification;
    [self reportPage];
}

- (void)windowWillClose:(NSNotification *)notification {
    (void)notification;
    [self reportPage];
    [[NSNotificationCenter defaultCenter] removeObserver:self];
    [cove_pdf_windows removeObjectForKey:self.key];
}

@end

void nimbus_pdf_install(CovePdfPageCallback callback) {
    cove_pdf_callback = callback;
}

static NSView *cove_pdf_sidebar(PDFView *pdfView) {
    PDFThumbnailView *thumbnails = [[PDFThumbnailView alloc] initWithFrame:NSMakeRect(0, 0, 150, 600)];
    thumbnails.PDFView = pdfView;
    thumbnails.thumbnailSize = NSMakeSize(96, 128);
    thumbnails.backgroundColor = NSColor.clearColor;
    thumbnails.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    NSVisualEffectView *material = [[NSVisualEffectView alloc] initWithFrame:thumbnails.frame];
    material.material = NSVisualEffectMaterialSidebar;
    material.blendingMode = NSVisualEffectBlendingModeBehindWindow;
    [material addSubview:thumbnails];
    return material;
}

void nimbus_pdf_open(const char *path, const char *title, const char *key, int page) {
    NSString *pathValue = [NSString stringWithUTF8String:path];
    NSString *titleValue = [NSString stringWithUTF8String:title];
    NSString *keyValue = [NSString stringWithUTF8String:key];
    dispatch_async(dispatch_get_main_queue(), ^{
        if (!cove_pdf_windows) cove_pdf_windows = [NSMutableDictionary dictionary];
        NSWindowController *existing = cove_pdf_windows[keyValue];
        if (existing) {
            [existing.window makeKeyAndOrderFront:nil];
            return;
        }
        PDFDocument *document = [[PDFDocument alloc] initWithURL:[NSURL fileURLWithPath:pathValue]];
        if (!document) return;

        NSRect frame = NSMakeRect(0, 0, 900, 1000);
        NSWindow *window = [[NSWindow alloc]
            initWithContentRect:frame
                      styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                                NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable
                        backing:NSBackingStoreBuffered
                          defer:NO];
        window.title = titleValue;
        window.releasedWhenClosed = NO;
        window.tabbingMode = NSWindowTabbingModeDisallowed;
        window.titlebarSeparatorStyle = NSTitlebarSeparatorStyleLine;
        window.minSize = NSMakeSize(420, 360);

        PDFView *pdfView = [[PDFView alloc] initWithFrame:frame];
        pdfView.document = document;
        pdfView.autoScales = YES;
        pdfView.displayMode = kPDFDisplaySinglePageContinuous;
        pdfView.displaysPageBreaks = YES;

        NSSplitView *split = [[NSSplitView alloc] initWithFrame:frame];
        split.vertical = YES;
        split.dividerStyle = NSSplitViewDividerStyleThin;
        split.autosaveName = @"CovePdfReaderSplit";
        if (document.pageCount > 1) {
            [split addArrangedSubview:cove_pdf_sidebar(pdfView)];
            [split setHoldingPriority:NSLayoutPriorityDefaultHigh + 1 forSubviewAtIndex:0];
        }
        [split addArrangedSubview:pdfView];
        window.contentView = split;
        if (document.pageCount > 1) [split setPosition:150 ofDividerAtIndex:0];

        CovePdfWindowController *controller = [[CovePdfWindowController alloc] initWithWindow:window];
        controller.key = keyValue;
        controller.pdfView = pdfView;
        window.delegate = controller;
        cove_pdf_windows[keyValue] = controller;

        // AppKit remembers each reader window's size and position between launches.
        [window setFrameAutosaveName:@"CovePdfReader"];
        if (![window setFrameUsingName:@"CovePdfReader"]) [window center];
        [controller showWindow:nil];

        NSInteger target = MAX(0, MIN((NSInteger)page, (NSInteger)document.pageCount - 1));
        PDFPage *start = [document pageAtIndex:target];
        if (start) [pdfView goToPage:start];
        [[NSNotificationCenter defaultCenter] addObserver:controller
                                                 selector:@selector(pageChanged:)
                                                     name:PDFViewPageChangedNotification
                                                   object:pdfView];
        [controller reportPage];
    });
}
