// bateson for Mac: a thin native shell around the web UI on localhost:4848 (or another port: see `port`).
// A normal window (shown and hidden with ⌃⌥Space), a Dock icon with the count, a menubar ring with the count,
// and a notification when a live session is waiting on you. The server itself runs as a login item; while there is
// none, the window says so, and why when the server could not start (a Node too old for it).
import AppKit
import Carbon
import UserNotifications
import WebKit

// The server's port: BATESON_PORT, like the server, when the app is started from a shell that has it. Opened from
// Finder or the Dock it has no such variable, so the installer also saves a port set at install in the app's
// defaults (`defaults read app.bateson port`); 0 when none was.
let savedPort = UserDefaults.standard.integer(forKey: "port")
let port = ProcessInfo.processInfo.environment["BATESON_PORT"].flatMap { Int($0) } ?? (savedPort > 0 ? savedPort : 4848)
let serverURL = URL(string: "http://localhost:\(port)/")!
let summaryURL = URL(string: "http://localhost:\(port)/api/summary")!
// The queue's folder, found as the port is: BATESON_HOME from a shell, else the one saved at install, else ~/.bateson.
// With no server to ask, the app reads server.error there: why the server cannot start (server/server.mjs).
let home = URL(fileURLWithPath: ProcessInfo.processInfo.environment["BATESON_HOME"].flatMap { $0.isEmpty ? nil : $0 }
  ?? UserDefaults.standard.string(forKey: "home")
  ?? (NSHomeDirectory() as NSString).appendingPathComponent(".bateson"))
// The web app's --work, light and dark (web/src/app.css), so the window never flashes the other one.
let paper = NSColor(name: nil) { look in
  look.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
    ? NSColor(srgbRed: 0x14 / 255, green: 0x14 / 255, blue: 0x14 / 255, alpha: 1)
    : NSColor(srgbRed: 0xFC / 255, green: 0xFC / 255, blue: 0xFB / 255, alpha: 1)
}

/// The server answers only who has its key (lib/key.ts): another account on this Mac reaches its port too. The key is
/// in the queue's folder, read each time since the server may make it after the app starts. The window's first request
/// carries it, and is answered with a cookie the page keeps for the rest.
func keyed(_ url: URL, cachePolicy: URLRequest.CachePolicy = .useProtocolCachePolicy, timeout: TimeInterval = 60) -> URLRequest {
  var request = URLRequest(url: url, cachePolicy: cachePolicy, timeoutInterval: timeout)
  if let key = try? String(contentsOf: home.appendingPathComponent("key"), encoding: .utf8) {
    request.setValue("Bearer \(key.trimmingCharacters(in: .whitespacesAndNewlines))", forHTTPHeaderField: "Authorization")
  }
  return request
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
  struct Waiting: Decodable { let id: String; let n: Int?; let title: String; let repo: String? }
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
  // Rounds notified for ("<id>#<n>"), and those whose notification is still in Notification Centre.
  var notified = Set<String>()
  var showing = Set<String>()
  var firstPoll = true
  var hotKey: EventHotKeyRef?
  var hotKeyName = ""
  // The page loaded while there is no server, so it is loaded again only when what it says changes, and its load.
  var downPage: String?
  var downLoad: WKNavigation?
  // The next try for the server while it is down: one at a time, however many loads fail (a ⌘R on the waiting page
  // starts another), so tries do not pile up and each reload the page again once the server is back.
  var retry: DispatchWorkItem?

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
    web.load(keyed(serverURL))
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

  @objc func reload() { web.load(keyed(serverURL, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData)) }

  // The server is a login item; if it is not up yet, say so and try again. If it cannot start (a Node too old for
  // it), say why instead. The page is loaded again only when that changes, so its text (the command that fixes it)
  // can be selected and copied while the tries go on.
  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    // A load that was only cut short (⌘R while loading, a navigation cancelled below) is not the server being down.
    let e = error as NSError
    if (e.domain == NSURLErrorDomain && e.code == NSURLErrorCancelled) || (e.domain == "WebKitErrorDomain" && e.code == 102) { return }
    let page = serverDownPage()
    if page != downPage {
      downPage = page
      // At the server's address, so the page's own look for the server (and the theme it keeps) is bateson's.
      downLoad = webView.loadHTMLString(page, baseURL: serverURL)
    }
    retry?.cancel()
    let again = DispatchWorkItem { [weak self] in self?.reload() }
    retry = again
    DispatchQueue.main.asyncAfter(deadline: .now() + 2, execute: again)
  }

  // macOS ends the page's process when memory is short, or it crashes: the window would stay blank until ⌘R. The
  // page is loaded again instead; what you had started is kept by the page itself.
  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    reload()
  }

  // The server's page is up: the next time it is down, the page saying so is loaded afresh.
  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    if navigation != downLoad { downPage = nil; downLoad = nil; retry?.cancel(); retry = nil }
  }

  /// What the window says while there is no server: web/public/waiting.html, the page a browser shows then too, which
  /// mac/build.sh puts in the app. Why the server cannot start goes in its place for that, when server/server.mjs
  /// left it in server.error lately (launchd tries again every ten seconds, and each try writes it again).
  func serverDownPage() -> String {
    let file = home.appendingPathComponent("server.error")
    var why: String?
    if let at = (try? FileManager.default.attributesOfItem(atPath: file.path))?[.modificationDate] as? Date,
       Date().timeIntervalSince(at) < 600,
       let text = try? String(contentsOf: file, encoding: .utf8) {
      let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
      if !trimmed.isEmpty { why = trimmed }
    }
    let html = { (s: String) -> String in
      s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
    }
    let reason = why.map { "<div class=\"why\"><b>The bateson server cannot start.</b>\n\n\(html($0))</div>" } ?? ""
    guard var page = waitingPage else {
      // An app built without the page (it always has it): the words alone.
      return "<html><body style=\"font:14px -apple-system,system-ui\">\(reason.isEmpty ? "Waiting for the bateson server on localhost:\(port)" : reason)</body></html>"
    }
    page = page.replacingOccurrences(of: "<!--why-->", with: reason)
    return page
  }

  /// waiting.html as the app has it, with its font in it as data: the server it would come from is the one that is down.
  lazy var waitingPage: String? = {
    guard let url = Bundle.main.url(forResource: "waiting", withExtension: "html"),
          var page = try? String(contentsOf: url, encoding: .utf8) else { return nil }
    if let font = Bundle.main.url(forResource: "schibstedgrotesk-normal", withExtension: "woff2"),
       let data = try? Data(contentsOf: font) {
      page = page.replacingOccurrences(of: "/fonts/schibstedgrotesk-normal.woff2", with: "data:font/woff2;base64,\(data.base64EncodedString())")
    }
    return page
  }()

  // The window shows bateson and nothing else: there is no address bar to tell you otherwise. A link out opens in the
  // browser, only web and mail links: a link can come from an agent's markup (a component example, a live preview),
  // and a file, a network share or another app's link is never opened from one. Anything else that would take the
  // window away from bateson (a form, a script, a redirect, another page on this machine) is refused. Frames inside
  // the page are its own business: the page sandboxes them.
  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    guard let url = action.request.url else { decisionHandler(.allow); return }
    if let frame = action.targetFrame, !frame.isMainFrame { decisionHandler(.allow); return }
    let scheme = url.scheme?.lowercased() ?? ""
    // A new window (an attachment's link, Open link in the menu): this app has none to give, so a web or mail link
    // opens in the browser, bateson's own included (an attachment opens there from the server).
    if action.targetFrame == nil {
      if ["http", "https", "mailto"].contains(scheme) { NSWorkspace.shared.open(url) }
      decisionHandler(.cancel)
      return
    }
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
    // Asked every two seconds, so an answer that takes longer is not waited for: the requests would pile up.
    URLSession.shared.dataTask(with: keyed(summaryURL, cachePolicy: .reloadIgnoringLocalCacheData, timeout: 4)) { [weak self] data, _, _ in
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
    // Once per round: an item's next round (the same id) is news, but a wait that lapses for a moment within a round
    // (an early answer handed over, a wait renewed) is not.
    let round = { (w: Summary.Waiting) in "\(w.id)#\(w.n ?? 0)" }
    for w in s.waiting where !notified.contains(round(w)) {
      notified.insert(round(w))
      if firstPoll || mode == "none" { continue }
      let content = UNMutableNotificationContent()
      content.title = "A session is waiting on you"
      content.body = [w.title, w.repo].compactMap { $0 }.joined(separator: " · ")
      if s.config?.sound ?? true { content.sound = UNNotificationSound(named: UNNotificationSoundName("Notify.wav")) }
      UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: round(w), content: content, trigger: nil))
      showing.insert(round(w))
      if mode == "notify-forward" { show() }
    }
    // A session that stopped waiting (answered, or cancelled by its agent) takes its notification with it.
    let stale = showing.subtracting(s.waiting.map(round))
    if !stale.isEmpty {
      UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: Array(stale))
      showing.subtract(stale)
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
