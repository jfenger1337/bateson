// bateson for Mac: a thin native shell around the web UI on localhost:4848 (or BATESON_PORT, like the server).
// A normal window (shown and hidden with ⌃⌥Space), a Dock icon with the count, a menubar ring with the count,
// and a notification when a live session is waiting on you. The server itself runs as a login item.
import AppKit
import Carbon
import UserNotifications
import WebKit

let port = ProcessInfo.processInfo.environment["BATESON_PORT"].flatMap { Int($0) } ?? 4848
let serverURL = URL(string: "http://localhost:\(port)/")!
let summaryURL = URL(string: "http://localhost:\(port)/api/summary")!
// The web app's --work, light and dark (web/src/app.css), so the window never flashes the other one.
let paper = NSColor(name: nil) { look in
  look.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
    ? NSColor(srgbRed: 0x14 / 255, green: 0x14 / 255, blue: 0x14 / 255, alpha: 1)
    : NSColor(srgbRed: 0xFC / 255, green: 0xFC / 255, blue: 0xFB / 255, alpha: 1)
}

@main
enum Main {
  static let delegate = AppDelegate()
  static func main() {
    let app = NSApplication.shared
    app.delegate = delegate
    app.setActivationPolicy(.regular)
    app.run()
  }
}

struct Summary: Decodable {
  struct Waiting: Decodable { let id: String; let title: String; let repo: String? }
  struct Config: Decodable { let blocked: String; let sound: Bool; let hotkey: String; let theme: String? }
  let count: Int
  let waiting: [Waiting]
  let config: Config?
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, UNUserNotificationCenterDelegate {
  var window: NSWindow!
  var web: WKWebView!
  var status: NSStatusItem!
  var countItem: NSMenuItem!
  var notified = Set<String>()
  var firstPoll = true
  var hotKey: EventHotKeyRef?
  var hotKeyName = ""

  func applicationDidFinishLaunching(_ note: Notification) {
    buildMenu()
    buildWindow()
    buildStatusItem()
    installHotKeyHandler()
    setHotKey("ctrl+option+space")
    let center = UNUserNotificationCenter.current()
    center.delegate = self
    // .badge too: without it macOS keeps the Dock count hidden, though the app sets it.
    center.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.poll() }
    poll()
    show()
  }

  // The Dock icon reopens the window after it was closed.
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    show()
    return true
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

  // MARK: Window

  func buildWindow() {
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .default()
    // A question's sounds play when you point at an option, which is not a click: let media play without one.
    config.mediaTypesRequiringUserActionForPlayback = []
    web = WKWebView(frame: .zero, configuration: config)
    web.navigationDelegate = self
    web.setValue(false, forKey: "drawsBackground")
    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1120, height: 820),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered, defer: false)
    window.title = "bateson"
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = true
    window.backgroundColor = paper
    window.isReleasedWhenClosed = false
    window.minSize = NSSize(width: 520, height: 420)
    window.contentView = web
    window.center()
    window.setFrameAutosaveName("bateson.main")
    web.load(URLRequest(url: serverURL))
  }

  @objc func show() {
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  func toggle() {
    if NSApp.isActive && window.isVisible && window.isKeyWindow { NSApp.hide(nil) } else { show() }
  }

  @objc func openSettings() {
    show()
    web.evaluateJavaScript("window.dispatchEvent(new Event('qr-settings'))")
  }

  @objc func reload() { web.load(URLRequest(url: serverURL, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData)) }

  // The server is a login item; if it is not up yet, say so and try again.
  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    // A load that was only cut short (⌘R while loading, a navigation cancelled below) is not the server being down.
    let e = error as NSError
    if (e.domain == NSURLErrorDomain && e.code == NSURLErrorCancelled) || (e.domain == "WebKitErrorDomain" && e.code == 102) { return }
    webView.loadHTMLString("""
      <html><style>body{background:#FCFCFB;color:#66696F}@media(prefers-color-scheme:dark){body{background:#141414;color:#99948C}}</style>
      <body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;font:14px -apple-system,system-ui">Waiting for the bateson server on localhost:\(port)</body></html>
      """, baseURL: nil)
    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.reload() }
  }

  // The window shows bateson and nothing else: there is no address bar to tell you otherwise. A link out opens in the
  // browser, only web and mail links: a link can come from an agent's markup (a component example, a live preview),
  // and a file, a network share or another app's link is never opened from one. Anything else that would take the
  // window away from bateson (a form, a script, a redirect, another page on this machine) is refused. Frames inside
  // the page are its own business: the page sandboxes them.
  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    guard let url = action.request.url else { decisionHandler(.allow); return }
    if let frame = action.targetFrame, !frame.isMainFrame { decisionHandler(.allow); return }
    let scheme = url.scheme?.lowercased() ?? ""
    let ours = scheme == "http" && url.host == "localhost" && url.port == port
    if ours || scheme == "about" { decisionHandler(.allow); return }
    if action.navigationType == .linkActivated, ["http", "https", "mailto"].contains(scheme) { NSWorkspace.shared.open(url) }
    decisionHandler(.cancel)
  }

  // MARK: Menus

  func buildMenu() {
    let main = NSMenu()
    func sub(_ title: String, _ items: [NSMenuItem]) {
      let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
      let menu = NSMenu(title: title)
      items.forEach(menu.addItem)
      item.submenu = menu
      main.addItem(item)
    }
    func mi(_ title: String, _ action: Selector?, _ key: String, _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
      let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
      i.keyEquivalentModifierMask = mods
      return i
    }
    let settingsItem = mi("Settings…", #selector(openSettings), ",")
    settingsItem.target = self
    sub("bateson", [
      settingsItem,
      .separator(),
      mi("Hide bateson", #selector(NSApplication.hide(_:)), "h"),
      .separator(),
      mi("Quit bateson", #selector(NSApplication.terminate(_:)), "q"),
    ])
    sub("Edit", [
      mi("Undo", Selector(("undo:")), "z"),
      mi("Redo", Selector(("redo:")), "z", [.command, .shift]),
      .separator(),
      mi("Cut", #selector(NSText.cut(_:)), "x"),
      mi("Copy", #selector(NSText.copy(_:)), "c"),
      mi("Paste", #selector(NSText.paste(_:)), "v"),
      mi("Select All", #selector(NSText.selectAll(_:)), "a"),
    ])
    let reloadItem = mi("Reload", #selector(reload), "r")
    reloadItem.target = self
    sub("View", [reloadItem])
    sub("Window", [
      mi("Close", #selector(NSWindow.performClose(_:)), "w"),
      mi("Minimise", #selector(NSWindow.performMiniaturize(_:)), "m"),
    ])
    NSApp.mainMenu = main
  }

  // MARK: Menubar

  func buildStatusItem() {
    status = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    status.button?.image = ringImage(filled: false)
    status.button?.imagePosition = .imageLeading
    let menu = NSMenu()
    let open = NSMenuItem(title: "Open bateson", action: #selector(show), keyEquivalent: "")
    open.target = self
    countItem = NSMenuItem(title: "Nothing is waiting", action: nil, keyEquivalent: "")
    countItem.isEnabled = false
    menu.addItem(open)
    menu.addItem(countItem)
    menu.addItem(.separator())
    menu.addItem(NSMenuItem(title: "Quit bateson", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
    status.menu = menu
  }

  func poll() {
    URLSession.shared.dataTask(with: summaryURL) { [weak self] data, _, _ in
      guard let data, let s = try? JSONDecoder().decode(Summary.self, from: data) else { return }
      DispatchQueue.main.async { self?.apply(s) }
    }.resume()
  }

  func apply(_ s: Summary) {
    let blocked = !s.waiting.isEmpty
    status.button?.image = ringImage(filled: blocked)
    status.button?.title = s.count > 0 ? " \(s.count)" : ""
    countItem.title = s.count == 0 ? "Nothing is waiting" : s.count == 1 ? "1 waiting" : "\(s.count) waiting"
    NSApp.dockTile.badgeLabel = s.count > 0 ? "\(s.count)" : nil
    let mode = s.config?.blocked ?? "notify"
    if let key = s.config?.hotkey, key != hotKeyName { setHotKey(key) }
    // Appearance from settings: the window (and the ground behind the page) takes the chosen look, or the system's.
    let look: NSAppearance? = s.config?.theme == "dark" ? NSAppearance(named: .darkAqua) : s.config?.theme == "light" ? NSAppearance(named: .aqua) : nil
    if window.appearance?.name != look?.name { window.appearance = look }

    // A notification only when a live session is waiting on you, once per item, never for what was there at launch.
    for w in s.waiting where !notified.contains(w.id) {
      notified.insert(w.id)
      if firstPoll || mode == "none" { continue }
      let content = UNMutableNotificationContent()
      content.title = "A session is waiting on you"
      content.body = [w.title, w.repo].compactMap { $0 }.joined(separator: " · ")
      if s.config?.sound ?? true { content.sound = UNNotificationSound(named: UNNotificationSoundName("Notify.wav")) }
      UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: w.id, content: content, trigger: nil))
      if mode == "notify-forward" { show() }
    }
    // A session that stopped waiting (answered, or cancelled by its agent) takes its notification with it.
    let stale = notified.subtracting(s.waiting.map { $0.id })
    // And is forgotten, so the item's next round (the same id, sent again) notifies again when a session waits on it.
    if !stale.isEmpty {
      UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: Array(stale))
      notified.subtract(stale)
    }
    firstPoll = false
  }

  func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler done: @escaping () -> Void) {
    DispatchQueue.main.async { self.show() }
    done()
  }

  func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
    // Already looking at the queue: no banner.
    done(NSApp.isActive && window.isKeyWindow ? [] : [.banner, .sound])
  }

  // MARK: Hotkey ⌃⌥Space (Carbon: no Accessibility permission needed)

  func installHotKeyHandler() {
    var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
      DispatchQueue.main.async { Main.delegate.toggle() }
      return noErr
    }, 1, &spec, nil, nil)
  }

  // The hotkey comes from settings: ~/.bateson/config.json, "hotkey".
  func setHotKey(_ name: String) {
    if let hotKey { UnregisterEventHotKey(hotKey) }
    hotKey = nil
    hotKeyName = name
    let combos: [String: (Int, Int)] = [
      "ctrl+option+space": (kVK_Space, controlKey | optionKey),
      "option+q": (kVK_ANSI_Q, optionKey),
      "cmd+shift+space": (kVK_Space, cmdKey | shiftKey),
    ]
    guard let (code, mods) = combos[name] else { return }
    let id = EventHotKeyID(signature: OSType(0x5152_5252), id: 1)
    RegisterEventHotKey(UInt32(code), UInt32(mods), id, GetApplicationEventTarget(), 0, &hotKey)
  }
}

// MARK: Drawing: Bateson's mark. An open ring is waiting; a ring with its dot is a session blocked on you.

func ringImage(filled: Bool) -> NSImage {
  let img = NSImage(size: NSSize(width: 16, height: 16), flipped: false) { rect in
    let r = rect.insetBy(dx: 2.25, dy: 2.25)
    let ring = NSBezierPath(ovalIn: r)
    ring.lineWidth = 1.5
    NSColor.black.setStroke()
    ring.stroke()
    if filled {
      NSColor.black.setFill()
      NSBezierPath(ovalIn: rect.insetBy(dx: 5.5, dy: 5.5)).fill()
    }
    return true
  }
  img.isTemplate = true
  return img
}
