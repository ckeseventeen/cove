import AppKit

let size = NSSize(width: 512, height: 512)
let image = NSImage(size: size)
image.lockFocus()

let bounds = NSRect(origin: .zero, size: size)
let background = NSBezierPath(roundedRect: bounds.insetBy(dx: 32, dy: 32), xRadius: 116, yRadius: 116)
let gradient = NSGradient(starting: NSColor(calibratedRed: 0.87, green: 1.0, blue: 0.51, alpha: 1), ending: NSColor(calibratedRed: 0.51, green: 0.87, blue: 0.70, alpha: 1))!
gradient.draw(in: background, angle: -45)

let cloud = NSBezierPath()
cloud.move(to: NSPoint(x: 150, y: 194))
cloud.curve(to: NSPoint(x: 161, y: 318), controlPoint1: NSPoint(x: 92, y: 205), controlPoint2: NSPoint(x: 96, y: 302))
cloud.line(to: NSPoint(x: 359, y: 318))
cloud.curve(to: NSPoint(x: 432, y: 252), controlPoint1: NSPoint(x: 401, y: 318), controlPoint2: NSPoint(x: 432, y: 289))
cloud.curve(to: NSPoint(x: 360, y: 186), controlPoint1: NSPoint(x: 432, y: 215), controlPoint2: NSPoint(x: 400, y: 186))
cloud.curve(to: NSPoint(x: 261, y: 108), controlPoint1: NSPoint(x: 350, y: 141), controlPoint2: NSPoint(x: 310, y: 108))
cloud.curve(to: NSPoint(x: 160, y: 194), controlPoint1: NSPoint(x: 210, y: 108), controlPoint2: NSPoint(x: 168, y: 146))
cloud.close()
NSColor(calibratedRed: 0.07, green: 0.09, blue: 0.12, alpha: 0.94).setFill()
cloud.fill()

image.unlockFocus()
guard let tiff = image.tiffRepresentation,
      let bitmap = NSBitmapImageRep(data: tiff),
      let png = bitmap.representation(using: .png, properties: [:]) else {
    fatalError("Unable to render icon")
}
let output = URL(fileURLWithPath: CommandLine.arguments[1])
try png.write(to: output)
