// bateson for Windows: a thin native shell around the web UI on localhost:4848, like mac/Sources/App.swift.
// A normal window (shown and hidden with Ctrl+Alt+Space), a tray ring with the count, a count on the taskbar
// button, and a notification when a live session is waiting on you. The server itself runs as a login item
// (scripts/install.ts --login); if it is not answering, the app starts it.
using System.Diagnostics;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Media;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Win32;
using Windows.Data.Xml.Dom;
using Windows.UI.Notifications;

namespace Bateson;

static class Program {
  public const string Aumid = "bateson";
  public static readonly Uri ServerUrl = new("http://localhost:4848/");
  public static readonly Uri SummaryUrl = new("http://localhost:4848/api/summary");
  public static readonly string DataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "bateson");

  [STAThread]
  static void Main(string[] args) {
    // One at a time: a second launch brings the first one's window forward and leaves.
    using var single = new Mutex(true, "bateson.app", out var first);
    using var wake = new EventWaitHandle(false, EventResetMode.AutoReset, "bateson.app.show");
    if (!first) { wake.Set(); return; }

    SetCurrentProcessExplicitAppUserModelID(Aumid);
    Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
    Application.EnableVisualStyles();
    Application.SetCompatibleTextRenderingDefault(false);
    var app = new MainForm(background: args.Contains("--background"));
    new Thread(() => { while (wake.WaitOne()) app.BeginInvoke(app.ShowFront); }) { IsBackground = true }.Start();
    Application.Run(app);
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern int SetCurrentProcessExplicitAppUserModelID(string id);
}

record Summary(int Count, List<Waiting> Waiting, SummaryConfig? Config);
record Waiting(string Id, string Title, string? Repo);
record SummaryConfig(string? Blocked, bool? Sound, string? Hotkey, string? Theme);
record Install(string? Repo, string? Node);

sealed class MainForm : Form {
  static readonly JsonSerializerOptions Json = new() { PropertyNameCaseInsensitive = true };
  // The web app's --work, light and dark (web/src/app.css), so the window never flashes the other one.
  static readonly Color PaperLight = Color.FromArgb(0xFA, 0xFA, 0xF8);
  static readonly Color PaperDark = Color.FromArgb(0x14, 0x14, 0x14);

  readonly WebView2 web = new() { Dock = DockStyle.Fill };
  readonly NotifyIcon tray = new();
  readonly ToolStripMenuItem countItem = new("Nothing is waiting") { Enabled = false };
  readonly ToolStripMenuItem loginItem = new("Start bateson at login") { CheckOnClick = true };
  readonly HttpClient http = new() { Timeout = TimeSpan.FromSeconds(3) };
  readonly System.Windows.Forms.Timer timer = new() { Interval = 2000 };
  readonly HashSet<string> notified = [];
  readonly string windowFile = Path.Combine(Program.DataDir, "window.txt");
  readonly bool background;
  bool firstPoll = true, quitting = false, startedServer = false, polling = false;
  int failures = 0;
  string hotKeyName = "", theme = "system";
  int lastCount = -1; bool lastBlocked = false;
  Icon? trayIcon, overlayIcon;
  ToastNotifier? toasts;
  // The notification sound: a short rising pop, made for bateson (mac/Notify.wav).
  static readonly Lazy<SoundPlayer?> Pop = new(() => {
    var wav = typeof(MainForm).Assembly.GetManifestResourceStream("Notify.wav");
    if (wav == null) return null;
    var player = new SoundPlayer(wav);
    player.Load();
    return player;
  });

  public MainForm(bool background) {
    this.background = background;
    Text = "bateson";
    Icon = Icon.ExtractAssociatedIcon(Environment.ProcessPath!);
    ClientSize = new Size(1120, 820);
    MinimumSize = new Size(520, 420);
    StartPosition = FormStartPosition.CenterScreen;
    BackColor = PaperLight;
    web.DefaultBackgroundColor = Color.Transparent;
    Controls.Add(web);
    RestorePlacement();
    BuildTray();
    RegisterToasts();
    SystemEvents.UserPreferenceChanged += (_, _) => { if (IsHandleCreated) BeginInvoke(ApplyTheme); };
    timer.Tick += (_, _) => Poll();
    // A hidden window has no taskbar button to carry the count: put it back when the window comes back.
    VisibleChanged += (_, _) => { if (Visible) lastCount = -1; };
  }

  // Started at login with --background: only the tray ring until there is something to see.
  protected override void SetVisibleCore(bool value) {
    if (background && !IsHandleCreated) { CreateHandle(); value = false; }
    base.SetVisibleCore(value);
  }

  protected override async void OnHandleCreated(EventArgs e) {
    base.OnHandleCreated(e);
    ApplyTheme();
    SetHotKey("ctrl+option+space");
    timer.Start();
    Poll();
    try {
      // A question's sounds play when you point at an option, which is not a click: let media play without one.
      var options = new CoreWebView2EnvironmentOptions("--autoplay-policy=no-user-gesture-required");
      var env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(Program.DataDir, "WebView2"), options);
      await web.EnsureCoreWebView2Async(env);
    } catch (WebView2RuntimeNotFoundException) {
      MessageBox.Show("bateson needs the Microsoft Edge WebView2 Runtime, which comes with Windows 10 and 11. Install it from https://go.microsoft.com/fwlink/p/?LinkId=2124703 and open bateson again.", "bateson");
      Quit();
      return;
    }
    var core = web.CoreWebView2;
    core.Settings.IsStatusBarEnabled = false;
    core.Settings.IsZoomControlEnabled = false;
    ApplyTheme();
    // Links out of the app open in the browser.
    core.NavigationStarting += (_, a) => {
      if (Uri.TryCreate(a.Uri, UriKind.Absolute, out var url) && url.Scheme.StartsWith("http") && url.Host != "localhost" && a.IsUserInitiated) {
        a.Cancel = true;
        OpenInBrowser(url);
      }
    };
    core.NewWindowRequested += (_, a) => {
      a.Handled = true;
      if (Uri.TryCreate(a.Uri, UriKind.Absolute, out var url)) OpenInBrowser(url);
    };
    // The server is a login item; if it is not up yet, say so and try again.
    core.NavigationCompleted += async (_, a) => {
      if (a.IsSuccess || a.WebErrorStatus == CoreWebView2WebErrorStatus.OperationCanceled) return;
      core.NavigateToString("""
        <html><style>body{background:#FCFCFB;color:#66696F}@media(prefers-color-scheme:dark){body{background:#141414;color:#99948C}}</style>
        <body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;font:14px 'Segoe UI',system-ui">Waiting for the bateson server on localhost:4848</body></html>
        """);
      await Task.Delay(2000);
      Reload();
    };
    core.Navigate(Program.ServerUrl.ToString());
  }

  void Reload() => web.CoreWebView2?.Navigate(Program.ServerUrl.ToString());

  static void OpenInBrowser(Uri url) {
    try { Process.Start(new ProcessStartInfo(url.ToString()) { UseShellExecute = true }); } catch { /* no browser */ }
  }

  // ---- Window

  public void ShowFront() {
    if (!Visible) Show();
    if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
    Activate();
    SetForegroundWindow(Handle);
  }

  void Toggle() {
    if (Visible && WindowState != FormWindowState.Minimized && ActiveForm == this) Hide(); else ShowFront();
  }

  void OpenSettings() {
    ShowFront();
    web.CoreWebView2?.ExecuteScriptAsync("window.dispatchEvent(new Event('qr-settings'))");
  }

  // Closing the window keeps bateson in the tray, as on a Mac; Quit is in the tray's menu.
  protected override void OnFormClosing(FormClosingEventArgs e) {
    SavePlacement();
    if (!quitting && e.CloseReason == CloseReason.UserClosing) { e.Cancel = true; Hide(); return; }
    base.OnFormClosing(e);
  }

  void Quit() {
    quitting = true;
    tray.Visible = false;
    UnregisterHotKey(Handle, HotKeyId);
    Application.Exit();
  }

  void RestorePlacement() {
    try {
      var p = File.ReadAllText(windowFile).Split(' ').Select(int.Parse).ToArray();
      var r = new Rectangle(p[0], p[1], p[2], p[3]);
      if (!Screen.AllScreens.Any(s => s.WorkingArea.IntersectsWith(r))) return;
      StartPosition = FormStartPosition.Manual;
      Bounds = r;
      if (p.Length > 4 && p[4] == 1) WindowState = FormWindowState.Maximized;
    } catch { /* first launch */ }
  }

  void SavePlacement() {
    try {
      var r = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
      Directory.CreateDirectory(Program.DataDir);
      File.WriteAllText(windowFile, $"{r.X} {r.Y} {r.Width} {r.Height} {(WindowState == FormWindowState.Maximized ? 1 : 0)}");
    } catch { /* not saved */ }
  }

  // Appearance from settings: the window, its title bar and the page take the chosen look, or the system's.
  void ApplyTheme() {
    var dark = theme == "dark" || (theme != "light" && SystemDark());
    BackColor = dark ? PaperDark : PaperLight;
    var on = dark ? 1 : 0;
    if (IsHandleCreated) DwmSetWindowAttribute(Handle, 20 /* DWMWA_USE_IMMERSIVE_DARK_MODE */, ref on, sizeof(int));
    if (web.CoreWebView2 is { } core) core.Profile.PreferredColorScheme =
      theme == "dark" ? CoreWebView2PreferredColorScheme.Dark : theme == "light" ? CoreWebView2PreferredColorScheme.Light : CoreWebView2PreferredColorScheme.Auto;
    lastCount = -1; // redraw the tray ring for the taskbar's colour
  }

  static bool SystemDark() => Registry.GetValue(@"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "AppsUseLightTheme", 1) is 0;
  static bool TaskbarDark() => Registry.GetValue(@"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "SystemUsesLightTheme", 0) is 0;

  // ---- Tray

  void BuildTray() {
    var menu = new ContextMenuStrip();
    menu.Items.Add("Open bateson", null, (_, _) => ShowFront());
    menu.Items.Add(countItem);
    menu.Items.Add("Settings…", null, (_, _) => OpenSettings());
    menu.Items.Add(new ToolStripSeparator());
    loginItem.Checked = StartsAtLogin;
    loginItem.CheckedChanged += (_, _) => StartsAtLogin = loginItem.Checked;
    menu.Items.Add(loginItem);
    menu.Items.Add(new ToolStripSeparator());
    menu.Items.Add("Quit bateson", null, (_, _) => Quit());
    tray.ContextMenuStrip = menu;
    tray.Text = "bateson";
    tray.MouseClick += (_, e) => { if (e.Button == MouseButtons.Left) Toggle(); };
    Draw(0, false);
    tray.Visible = true;
  }

  // The app at login, in the user's Run key. The server has its own entry (scripts/install.ts --login).
  const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
  static bool StartsAtLogin {
    get { using var k = Registry.CurrentUser.OpenSubKey(RunKey); return k?.GetValue("bateson app") is string; }
    set {
      using var k = Registry.CurrentUser.CreateSubKey(RunKey);
      if (value) k.SetValue("bateson app", $"\"{Environment.ProcessPath}\" --background");
      else k.DeleteValue("bateson app", false);
    }
  }

  async void Poll() {
    if (polling) return;
    polling = true;
    try {
      var s = JsonSerializer.Deserialize<Summary>(await http.GetStringAsync(Program.SummaryUrl), Json);
      failures = 0;
      if (s != null) Apply(s);
    } catch {
      // Nothing on 4848 for a few seconds: start the server this checkout's installer set up, once.
      if (++failures == 3 && !startedServer) StartServer();
    } finally { polling = false; }
  }

  void StartServer() {
    startedServer = true;
    try {
      var home = Environment.GetEnvironmentVariable("BATESON_HOME") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".bateson");
      var install = JsonSerializer.Deserialize<Install>(File.ReadAllText(Path.Combine(home, "install.json")), Json);
      if (install?.Repo is not { } repo) return;
      var script = Path.Combine(repo, "scripts", "keepalive.ts");
      if (!File.Exists(script)) return;
      var info = new ProcessStartInfo(install.Node ?? "node") { WorkingDirectory = repo, UseShellExecute = false, CreateNoWindow = true };
      info.ArgumentList.Add(script);
      Process.Start(info);
    } catch { /* not installed: the page keeps saying it is waiting */ }
  }

  void Apply(Summary s) {
    var blocked = s.Waiting is { Count: > 0 };
    if (s.Count != lastCount || blocked != lastBlocked) Draw(s.Count, blocked);
    lastCount = s.Count; lastBlocked = blocked;
    var waiting = s.Count == 0 ? "Nothing is waiting" : s.Count == 1 ? "1 waiting" : $"{s.Count} waiting";
    countItem.Text = waiting;
    tray.Text = s.Count == 0 ? "bateson" : $"bateson: {waiting}";
    Text = s.Count == 0 ? "bateson" : $"bateson ({s.Count})";
    var mode = s.Config?.Blocked ?? "notify";
    if (s.Config?.Hotkey is { } key && key != hotKeyName) SetHotKey(key);
    if ((s.Config?.Theme ?? "system") != theme) { theme = s.Config?.Theme ?? "system"; ApplyTheme(); }

    // A notification only when a live session is waiting on you, once per item, never for what was there at launch.
    foreach (var w in s.Waiting ?? []) {
      if (!notified.Add(w.Id) || firstPoll || mode == "none") continue;
      // Already looking at the queue: no notification.
      if (Visible && ActiveForm == this) continue;
      Notify(w, s.Config?.Sound ?? true);
      if (mode == "notify-forward") ShowFront();
    }
    firstPoll = false;
  }

  // ---- Drawing: Bateson's mark. An open ring is waiting; a filled one is a session blocked on you. The count
  // sits inside it, and on the taskbar button.

  void Draw(int count, bool blocked) {
    var ink = TaskbarDark() ? Color.White : Color.Black;
    var size = SystemInformation.SmallIconSize.Width;
    var old = trayIcon;
    trayIcon = Ring(size, ink, count, blocked);
    tray.Icon = trayIcon;
    old?.Dispose();

    if (!IsHandleCreated) return;
    var oldOverlay = overlayIcon;
    overlayIcon = count > 0 ? Badge(size, count) : null;
    Taskbar.SetOverlay(Handle, overlayIcon, count > 0 ? $"{count} waiting" : "");
    oldOverlay?.Dispose();
  }

  static string Label(int count) => count > 9 ? "9+" : count.ToString();

  static Icon Ring(int size, Color ink, int count, bool filled) {
    using var bmp = new Bitmap(size, size);
    using (var g = Graphics.FromImage(bmp)) {
      g.SmoothingMode = SmoothingMode.AntiAlias;
      g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
      var w = size / 10f;
      var r = new RectangleF(w, w, size - 2 * w - 1, size - 2 * w - 1);
      if (filled) using (var b = new SolidBrush(ink)) g.FillEllipse(b, r);
      using (var p = new Pen(ink, w * 1.4f)) g.DrawEllipse(p, r);
      if (count > 0) {
        using var font = new Font("Segoe UI", size * (count > 9 ? 0.34f : 0.46f), FontStyle.Bold, GraphicsUnit.Pixel);
        using var text = new SolidBrush(filled ? (ink.R > 128 ? Color.Black : Color.White) : ink);
        g.DrawString(Label(count), font, text, r, new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center });
      }
    }
    return FromBitmap(bmp);
  }

  static Icon Badge(int size, int count) {
    using var bmp = new Bitmap(size, size);
    using (var g = Graphics.FromImage(bmp)) {
      g.SmoothingMode = SmoothingMode.AntiAlias;
      g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
      using (var b = new SolidBrush(Color.FromArgb(0xD9, 0x3B, 0x2B))) g.FillEllipse(b, 0, 0, size - 1, size - 1);
      using var font = new Font("Segoe UI", size * (count > 9 ? 0.42f : 0.6f), FontStyle.Bold, GraphicsUnit.Pixel);
      g.DrawString(Label(count), font, Brushes.White, new RectangleF(0, 0, size, size), new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center });
    }
    return FromBitmap(bmp);
  }

  static Icon FromBitmap(Bitmap bmp) {
    var h = bmp.GetHicon();
    try { return (Icon)Icon.FromHandle(h).Clone(); } finally { DestroyIcon(h); }
  }

  // ---- Notifications: Windows toasts, silent, with bateson's own sound played here.

  void RegisterToasts() {
    try {
      // An app without an installer names itself to Windows here, so its notifications carry its name and icon.
      using var k = Registry.CurrentUser.CreateSubKey($@"Software\Classes\AppUserModelId\{Program.Aumid}");
      k.SetValue("DisplayName", "bateson");
      k.SetValue("IconUri", Path.Combine(AppContext.BaseDirectory, "AppIcon.png"));
      toasts = ToastNotificationManager.CreateToastNotifier(Program.Aumid);
    } catch { /* no notifications on this Windows */ }
  }

  void Notify(Waiting w, bool sound) {
    if (toasts == null) return;
    try {
      var xml = new XmlDocument();
      xml.LoadXml("<toast><visual><binding template=\"ToastGeneric\"><text/><text/></binding></visual><audio silent=\"true\"/></toast>");
      var texts = xml.GetElementsByTagName("text");
      texts[0].AppendChild(xml.CreateTextNode("A session is waiting on you"));
      texts[1].AppendChild(xml.CreateTextNode(string.Join(" · ", new[] { w.Title, w.Repo }.Where(x => !string.IsNullOrEmpty(x)))));
      var toast = new ToastNotification(xml) { Tag = w.Id.Length > 64 ? w.Id[..64] : w.Id };
      toast.Activated += (_, _) => BeginInvoke(ShowFront);
      toasts.Show(toast);
      if (sound) Pop.Value?.Play();
    } catch { /* notifications turned off */ }
  }

  // ---- Hotkey, from settings: ~/.bateson/config.json, "hotkey". Option is Alt here, and cmd is Ctrl.

  const int HotKeyId = 1, WM_HOTKEY = 0x0312;

  void SetHotKey(string name) {
    UnregisterHotKey(Handle, HotKeyId);
    hotKeyName = name;
    const uint Alt = 1, Ctrl = 2, Shift = 4, NoRepeat = 0x4000;
    (uint mods, uint key)? combo = name switch {
      "ctrl+option+space" => (Ctrl | Alt, 0x20),
      "option+q" => (Alt, 0x51),
      "cmd+shift+space" => (Ctrl | Shift, 0x20),
      _ => null,
    };
    if (combo is { } c) RegisterHotKey(Handle, HotKeyId, c.mods | NoRepeat, c.key);
  }

  protected override void WndProc(ref Message m) {
    if (m.Msg == WM_HOTKEY && m.WParam == HotKeyId) Toggle();
    base.WndProc(ref m);
  }

  [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr hWnd, int id, uint mods, uint vk);
  [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr hWnd, int id);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr hIcon);
  [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
}

// The count on the taskbar button: ITaskbarList3's overlay icon.
static class Taskbar {
  [ComImport, Guid("ea1afb91-9e28-4b86-90e9-9e9f8a5eefaf"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface ITaskbarList3 {
    // ITaskbarList
    void HrInit(); void AddTab(IntPtr hwnd); void DeleteTab(IntPtr hwnd); void ActivateTab(IntPtr hwnd); void SetActiveAlt(IntPtr hwnd);
    // ITaskbarList2
    void MarkFullscreenWindow(IntPtr hwnd, [MarshalAs(UnmanagedType.Bool)] bool fullscreen);
    // ITaskbarList3, up to the one used here
    void SetProgressValue(IntPtr hwnd, ulong done, ulong total); void SetProgressState(IntPtr hwnd, int flags);
    void RegisterTab(IntPtr tab, IntPtr hwnd); void UnregisterTab(IntPtr tab); void SetTabOrder(IntPtr tab, IntPtr before);
    void SetTabActive(IntPtr tab, IntPtr hwnd, uint reserved); void ThumbBarAddButtons(IntPtr hwnd, uint count, IntPtr buttons);
    void ThumbBarUpdateButtons(IntPtr hwnd, uint count, IntPtr buttons); void ThumbBarSetImageList(IntPtr hwnd, IntPtr imageList);
    void SetOverlayIcon(IntPtr hwnd, IntPtr icon, [MarshalAs(UnmanagedType.LPWStr)] string description);
  }

  [ComImport, Guid("56FDF344-FD6D-11d0-958A-006097C9A090"), ClassInterface(ClassInterfaceType.None)]
  class TaskbarList { }

  static ITaskbarList3? list;

  public static void SetOverlay(IntPtr hwnd, Icon? icon, string description) {
    try {
      if (list == null) { list = (ITaskbarList3)new TaskbarList(); list.HrInit(); }
      list.SetOverlayIcon(hwnd, icon?.Handle ?? IntPtr.Zero, description);
    } catch { /* no taskbar button yet, or no taskbar */ }
  }
}
