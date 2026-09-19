import UIKit
import AVFoundation

/// Runs the actual patched loop controller on a generated, local 30 fps clip.
/// Video-output samples measure decoded-frame availability, NOT compositor
/// presentation. Use Instruments Display for the app's presentation gate.
@main
final class ProbeApp: UIResponder, UIApplicationDelegate {
  var window: UIWindow?
  func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
    application.isIdleTimerDisabled = true
    let window = UIWindow(frame: UIScreen.main.bounds)
    window.rootViewController = ProbeController()
    window.makeKeyAndVisible()
    self.window = window
    return true
  }
}

final class ProbeController: UIViewController {
  let label = UILabel()
  let layer = AVPlayerLayer()
  var player = AVPlayer()
  var loop: VideoPlayerLoopController?
  var display: CADisplayLink?
  var endObserver: NSObjectProtocol?
  var outputs: [ObjectIdentifier: AVPlayerItemVideoOutput] = [:]
  var gaps: [Double] = []
  var boundaries: [Double] = []
  var lastHost: Double?
  var lastPTS: Double?
  var phaseStart = 0.0
  var phase = "seek"
  var report: [String: Any] = [:]
  var maximumItems = 0

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black
    view.layer.addSublayer(layer)
    label.textColor = .white
    label.numberOfLines = 0
    label.backgroundColor = .black
    view.addSubview(label)
    start(queue: false)
    display = CADisplayLink(target: self, selector: #selector(tick(_:)))
    display?.add(to: .main, forMode: .common)
  }

  override func viewDidLayoutSubviews() {
    layer.frame = view.bounds
    label.frame = CGRect(x: 12, y: 60, width: view.bounds.width - 24, height: 110)
  }

  func start(queue: Bool) {
    if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
    player.pause()
    loop?.reset()
    player.replaceCurrentItem(with: nil)
    outputs.removeAll()
    gaps = []; boundaries = []; lastHost = nil; lastPTS = nil; maximumItems = 0
    player = queue ? AVQueuePlayer() : AVPlayer()
    if let queuePlayer = player as? AVQueuePlayer {
      loop = VideoPlayerLoopController(player: queuePlayer)
    }
    let item = AVPlayerItem(url: Bundle.main.url(forResource: "loop", withExtension: "mp4")!)
    player.replaceCurrentItem(with: item)
    if queue { loop?.prepare(item: item) }
    else {
      endObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak self] _ in
        self?.player.seek(to: .zero, toleranceBefore: .zero, toleranceAfter: .zero)
        self?.player.play()
      }
    }
    player.isMuted = true
    layer.player = player
    phaseStart = CACurrentMediaTime()
    label.text = "Native loop probe — \(phase)\nLocal 30 fps, 3-second fixture"
    player.play()
  }

  @objc func tick(_ link: CADisplayLink) {
    let now = CACurrentMediaTime()
    let items = (player as? AVQueuePlayer)?.items() ?? [player.currentItem].compactMap { $0 }
    maximumItems = max(maximumItems, items.count)
    for item in items where outputs[ObjectIdentifier(item)] == nil {
      let output = AVPlayerItemVideoOutput(pixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
      item.add(output)
      outputs[ObjectIdentifier(item)] = output
    }
    if let item = player.currentItem, let output = outputs[ObjectIdentifier(item)] {
      let time = output.itemTime(forHostTime: link.timestamp)
      if output.hasNewPixelBuffer(forItemTime: time) {
        var pts = CMTime.invalid
        if output.copyPixelBuffer(forItemTime: time, itemTimeForDisplay: &pts) != nil {
          if let lastHost, let lastPTS, now - phaseStart > 1 {
            let gap = (now - lastHost) * 1000
            gaps.append(gap)
            if pts.seconds < lastPTS - 0.5 { boundaries.append(gap) }
          }
          lastHost = now; lastPTS = pts.seconds
        }
      }
    }
    if now - phaseStart >= 64 {
      let sorted = gaps.sorted()
      report[phase] = ["samples": gaps.count, "loopBoundariesMs": boundaries,
        "gapP95Ms": sorted.isEmpty ? 0 : sorted[Int(Double(sorted.count - 1) * 0.95)],
        "maxQueueItems": maximumItems, "nativeLooperReady": loop?.isLooping ?? false]
      if phase == "seek" { phase = "queue"; start(queue: true) }
      else { finish() }
    }
  }

  func finish() {
    display?.invalidate()
    player.pause()
    // Exercise cancellation, disabling, replacement and release on the exact
    // controller. Assertions concern lifecycle, not a claimed UI frame rate.
    let retained = player.currentItem
    let before = player.currentTime().seconds
    loop?.disable()
    let preserved = player.currentItem === retained && abs(player.currentTime().seconds - before) < 0.05
    if let retained { loop?.prepare(item: retained) }
    loop?.reset()
    report["lifecycle"] = ["disablePreservesItemAndPosition": preserved,
      "resetEmptiesQueue": (player as? AVQueuePlayer)?.items().isEmpty ?? false]
    report["device"] = UIDevice.current.model
    report["system"] = UIDevice.current.systemVersion
    report["measurement"] = "decoded output availability; not displayed frames"
    let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("results.json")
    if let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]) {
      try? data.write(to: url)
      print(String(data: data, encoding: .utf8)!)
    }
    label.text = "Complete — results.json\nLifecycle preserved: \(preserved)\nQueue boundaries: \(boundaries.count)"
  }
}
