// Generates Cove's app icon ("潮汐": a play button holding sky above and sea below one white crest).
//
//   swift scripts/generate_icon.swift
//
// Writes src-tauri/icons/AppIcon.icon (an Icon Composer document: the layers plus icon.json with a
// light and a dark background), compiles it with Xcode's actool into Assets.car — the icon macOS 26+
// shows, following the light, dark and tinted icon appearances — and icon.icns for older systems,
// then renders the PNG sizes Tauri embeds. Needs Xcode 26 or later.
import AppKit
import CoreGraphics

let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
let icons = root.appendingPathComponent("src-tauri/icons")
let document = icons.appendingPathComponent("AppIcon.icon")
let space = CGColorSpace(name: CGColorSpace.displayP3)!

func color(_ hex: UInt32, _ alpha: CGFloat = 1) -> CGColor {
    CGColor(colorSpace: space, components: [
        CGFloat((hex >> 16) & 0xff) / 255, CGFloat((hex >> 8) & 0xff) / 255, CGFloat(hex & 0xff) / 255, alpha,
    ])!
}

/// "display-p3:r,g,b,a", as icon.json spells a colour.
func p3(_ hex: UInt32) -> String {
    let parts = [(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff].map { String(format: "%.5f", Double($0) / 255) }
    return "display-p3:" + parts.joined(separator: ",") + ",1.00000"
}

// MARK: Geometry, on Icon Composer's 1024 pt canvas (the whole tile; the system adds the margin).

let canvas: CGFloat = 1024
let center = CGPoint(x: 512, y: 512)

/// A play triangle pointing right with rounded corners, nudged right to look centred.
func playTriangle(size: CGFloat, radius: CGFloat) -> CGPath {
    let h = size, w = size * 0.92
    let cx = center.x + w * 0.08
    let a = CGPoint(x: cx - w / 2, y: center.y + h / 2)
    let b = CGPoint(x: cx + w / 2, y: center.y)
    let c = CGPoint(x: cx - w / 2, y: center.y - h / 2)
    let path = CGMutablePath()
    path.move(to: CGPoint(x: (a.x + c.x) / 2, y: (a.y + c.y) / 2))
    path.addArc(tangent1End: a, tangent2End: b, radius: radius)
    path.addArc(tangent1End: b, tangent2End: c, radius: radius)
    path.addArc(tangent1End: c, tangent2End: a, radius: radius)
    path.closeSubpath()
    return path
}

let triangle = playTriangle(size: 660, radius: 100)
let crestY: CGFloat = 436, crestAmplitude: CGFloat = 56, crestSpan: CGFloat = 400, crestStart: CGFloat = 112

/// The crest line: two gentle swells across the triangle.
func crestLine() -> CGMutablePath {
    let path = CGMutablePath()
    path.move(to: CGPoint(x: crestStart, y: crestY))
    for i in 0..<2 {
        let x = crestStart + CGFloat(i) * crestSpan
        path.addCurve(to: CGPoint(x: x + crestSpan, y: crestY),
                      control1: CGPoint(x: x + crestSpan * 0.35, y: crestY + crestAmplitude),
                      control2: CGPoint(x: x + crestSpan * 0.65, y: crestY - crestAmplitude))
    }
    return path
}

/// Everything below the crest line.
func seaRegion() -> CGPath {
    let path = crestLine()
    path.addLine(to: CGPoint(x: crestStart + 2 * crestSpan, y: 0))
    path.addLine(to: CGPoint(x: crestStart, y: 0))
    path.closeSubpath()
    return path
}

func linear(_ context: CGContext, _ colors: [CGColor], from: CGPoint, to: CGPoint) {
    let gradient = CGGradient(colorsSpace: space, colors: colors as CFArray, locations: nil)!
    context.drawLinearGradient(gradient, start: from, end: to, options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
}

func bitmap(_ size: Int) -> CGContext {
    CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
              space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
}

func save(_ context: CGContext, _ url: URL) throws {
    let rep = NSBitmapImageRep(cgImage: context.makeImage()!)
    try rep.representation(using: .png, properties: [:])!.write(to: url)
}

// MARK: Layers

/// Sky: the whole play button, pale aqua.
func drawSky(_ c: CGContext) {
    c.addPath(triangle)
    c.clip()
    linear(c, [color(0x8CEDF3), color(0x35BCE9)], from: CGPoint(x: 512, y: 830), to: CGPoint(x: 512, y: 450))
}

/// Sea: the play button below the crest, deep blue.
func drawSea(_ c: CGContext) {
    c.addPath(triangle)
    c.clip()
    c.addPath(seaRegion())
    c.clip()
    linear(c, [color(0x1F93DD), color(0x2549C2)], from: CGPoint(x: 512, y: 470), to: CGPoint(x: 512, y: 210))
}

/// Crest: one white wave line across the button.
func drawCrest(_ c: CGContext) {
    c.addPath(triangle)
    c.clip()
    c.addPath(crestLine())
    c.setLineWidth(38)
    c.setLineCap(.round)
    c.setStrokeColor(color(0xFFFFFF))
    c.strokePath()
}

let layers: [(name: String, draw: (CGContext) -> Void, glass: Bool)] = [
    ("sky", drawSky, true),
    ("sea", drawSea, true),
    ("crest", drawCrest, false),
]

// Background: near white in the light appearance, near black in the dark one, as Apple's icons are.
let lightFill = (top: 0xFFFFFF as UInt32, bottom: 0xE4ECF4 as UInt32)
let darkFill = (top: 0x222222 as UInt32, bottom: 0x111111 as UInt32)

// MARK: Icon Composer document

func writeDocument() throws {
    let assets = document.appendingPathComponent("Assets")
    try? FileManager.default.removeItem(at: document)
    try FileManager.default.createDirectory(at: assets, withIntermediateDirectories: true)
    for layer in layers {
        let context = bitmap(Int(canvas))
        layer.draw(context)
        try save(context, assets.appendingPathComponent("\(layer.name).png"))
    }
    func gradient(_ fill: (top: UInt32, bottom: UInt32)) -> [String: Any] {
        ["linear-gradient": [p3(fill.top), p3(fill.bottom)],
         "orientation": ["start": ["x": 0.5, "y": 0.0], "stop": ["x": 0.5, "y": 1.0]]]
    }
    let json: [String: Any] = [
        "fill-specializations": [
            ["value": gradient(lightFill)],
            ["appearance": "dark", "value": gradient(darkFill)],
        ],
        "groups": [[
            "layers": layers.reversed().map { layer in
                ["image-name": "\(layer.name).png", "name": layer.name, "glass": layer.glass] as [String: Any]
            },
            "shadow": ["kind": "neutral", "opacity": 0.5],
            "translucency": ["enabled": false, "value": 0.5],
        ]],
        "supported-platforms": ["circles": ["watchOS"], "squares": "shared"],
    ]
    let data = try JSONSerialization.data(withJSONObject: json, options: [.prettyPrinted, .sortedKeys])
    try data.write(to: document.appendingPathComponent("icon.json"))
}

// MARK: Compile with actool

@discardableResult
func run(_ arguments: [String]) throws -> String {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
    process.arguments = arguments
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = pipe
    try process.run()
    let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    process.waitUntilExit()
    guard process.terminationStatus == 0 else {
        throw NSError(domain: "generate_icon", code: Int(process.terminationStatus), userInfo: [NSLocalizedDescriptionKey: output])
    }
    return output
}

func compile() throws -> URL {
    let build = FileManager.default.temporaryDirectory.appendingPathComponent("cove-icon-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: build, withIntermediateDirectories: true)
    try run(["actool", document.path, "--compile", build.path, "--platform", "macosx",
             "--minimum-deployment-target", "13.0", "--app-icon", "AppIcon",
             "--output-partial-info-plist", build.appendingPathComponent("partial.plist").path,
             "--output-format", "human-readable-text", "--notices", "--warnings", "--errors"])
    let fm = FileManager.default
    for name in ["Assets.car", "AppIcon.icns"] {
        let target = icons.appendingPathComponent(name == "AppIcon.icns" ? "icon.icns" : name)
        try? fm.removeItem(at: target)
        try fm.copyItem(at: build.appendingPathComponent(name), to: target)
    }
    return build
}

// MARK: PNG sizes from the compiled icns (the light appearance, as the system draws it)

func writePNGs() throws {
    guard let image = NSImage(contentsOf: icons.appendingPathComponent("icon.icns")) else {
        throw NSError(domain: "generate_icon", code: 1, userInfo: [NSLocalizedDescriptionKey: "icon.icns is unreadable"])
    }
    for (name, size) in [("icon.png", 512), ("32x32.png", 32), ("64x64.png", 64), ("128x128.png", 128), ("128x128@2x.png", 256)] {
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8,
                                   samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                   bytesPerRow: 0, bitsPerPixel: 0)!
        rep.size = NSSize(width: size, height: size)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        NSGraphicsContext.current?.imageInterpolation = .high
        image.draw(in: NSRect(x: 0, y: 0, width: size, height: size))
        NSGraphicsContext.restoreGraphicsState()
        try rep.representation(using: .png, properties: [:])!.write(to: icons.appendingPathComponent(name))
    }
}

do {
    try writeDocument()
    let build = try compile()
    try writePNGs()
    try? FileManager.default.removeItem(at: build)
    print("Wrote \(document.path), Assets.car, icon.icns and the PNG sizes in \(icons.path)")
} catch {
    FileHandle.standardError.write("generate_icon: \(error.localizedDescription)\n".data(using: .utf8)!)
    exit(1)
}
