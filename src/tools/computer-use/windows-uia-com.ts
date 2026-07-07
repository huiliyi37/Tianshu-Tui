/**
 * UIA3 COM interop layer — the native IUIAutomation client (UIAutomationCore)
 * instead of the legacy managed System.Windows.Automation wrapper.
 *
 * Why: (1) a UIA3 COM client connection makes Chromium/Edge/Electron expose
 * their full accessibility tree (the managed client only sees the degraded
 * MSAA bridge) — this is the Windows analog of the macOS AXEnhancedUserInterface
 * enable; (2) the whole tree walk runs inside C# (one Add-Type class) instead
 * of interpreted PowerShell, eliminating per-node interpreter overhead on top
 * of the per-parent FindAllBuildCache batching; (3) JSON is emitted by C#
 * directly, so every ConvertTo-Json single-element-unwrap quirk disappears.
 *
 * How the ComImport declarations stay safe without a Windows machine:
 * - vtable slot ORDER is transcribed from the Windows 7 SDK
 *   UIAutomationClient.h (slot order is ABI-frozen; later SDKs only append
 *   derived interfaces like IUIAutomationElement2).
 * - Only methods we actually call get real signatures; every other slot is a
 *   `void _SlotN_Name();` placeholder (slot count is all that matters for
 *   vtable layout, and placeholders are never invoked).
 * - Interfaces are truncated after the highest slot we call.
 * - The C# sticks to what PowerShell 5.1's Add-Type compiler accepts (C# 5,
 *   default refs mscorlib/System only): no string interpolation, no
 *   null-conditional, no HashSet (System.Core).
 *
 * Runtime safety: callers must gate on `comReady()` — a one-time per-process
 * probe that compiles the prelude and touches the UIA root. Any failure marks
 * COM broken for the session and the driver falls back to the managed
 * builders. `RIVET_CU_COM=0` disables the COM path outright.
 *
 * Error-message parity is contractual: stale-snapshot messages, the set_value
 * fallback guidance, menu misses and the app-not-found wording are rendered
 * byte-identical to the managed path, because tool.ts self-healing and fuzzy
 * app hints match on them.
 */

import type { PowerShellRunner, ComboKeySpec } from './windows-driver.js'
import {
  psString,
  normalizeAppName,
  INPUT_PRELUDE,
  FOCUS_WINDOW,
  typeBodySnippet,
  keyBodySnippet,
  pasteBodySnippet,
  SCROLL_WINDOW_CENTER,
} from './windows-driver.js'
import type { ScrollOptions } from './macos-driver.js'

/** Max dimension for the vision-model screenshot copy (px) — mirrors driver. */
const VISION_MAX_DIMENSION = 1440

export const UIA_COM_PRELUDE = `
if (-not ('RivetUia' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

[StructLayout(LayoutKind.Sequential)]
public struct RivetUiaRect { public int left; public int top; public int right; public int bottom; }

[ComImport, Guid("352ffba8-0973-437c-a61f-f64cafd81df9"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IUIAutomationCondition { }

[ComImport, Guid("14314595-b4bc-4055-95f2-58f2e42c9855"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IUIAutomationElementArray {
  int get_Length();
  IUIAutomationElement GetElement(int index);
}

[ComImport, Guid("b32a92b5-bc25-4078-9c08-d7ee95c48e03"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IUIAutomationCacheRequest {
  void AddProperty(int propertyId);
  void AddPattern(int patternId);
  void _Slot3_Clone();
  void _Slot4_GetTreeScope();
  void put_TreeScope(int scope);
  void _Slot6_GetTreeFilter();
  void put_TreeFilter(IUIAutomationCondition filter);
}

[ComImport, Guid("fb377fbe-8ea6-46d5-9c73-6499642d3059"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IUIAutomationInvokePattern {
  void Invoke();
}

[ComImport, Guid("a94cd8b1-0844-4cd6-9d2d-640537ab39e9"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IUIAutomationValuePattern {
  void SetValue([MarshalAs(UnmanagedType.BStr)] string val);
  [return: MarshalAs(UnmanagedType.BStr)] string get_CurrentValue();
  void _Slot3_GetCurrentIsReadOnly();
  [return: MarshalAs(UnmanagedType.BStr)] string get_CachedValue();
}

[ComImport, Guid("619be086-1f4e-4ee4-bafa-210128738730"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IUIAutomationExpandCollapsePattern {
  void Expand();
}

[ComImport, Guid("d22108aa-8ac5-49a5-837b-37bbb3d7591e"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IUIAutomationElement {
  void _Slot01_SetFocus();
  void _Slot02_GetRuntimeId();
  IUIAutomationElement FindFirst(int scope, IUIAutomationCondition condition);
  IUIAutomationElementArray FindAll(int scope, IUIAutomationCondition condition);
  void _Slot05_FindFirstBuildCache();
  IUIAutomationElementArray FindAllBuildCache(int scope, IUIAutomationCondition condition, IUIAutomationCacheRequest cacheRequest);
  IUIAutomationElement BuildUpdatedCache(IUIAutomationCacheRequest cacheRequest);
  void _Slot08_GetCurrentPropertyValue();
  void _Slot09_GetCurrentPropertyValueEx();
  void _Slot10_GetCachedPropertyValue();
  void _Slot11_GetCachedPropertyValueEx();
  void _Slot12_GetCurrentPatternAs();
  void _Slot13_GetCachedPatternAs();
  [return: MarshalAs(UnmanagedType.IUnknown)] object GetCurrentPattern(int patternId);
  [return: MarshalAs(UnmanagedType.IUnknown)] object GetCachedPattern(int patternId);
  void _Slot16_GetCachedParent();
  void _Slot17_GetCachedChildren();
  int get_CurrentProcessId();
  int get_CurrentControlType();
  void _Slot20_GetCurrentLocalizedControlType();
  [return: MarshalAs(UnmanagedType.BStr)] string get_CurrentName();
  void _Slot22_GetCurrentAcceleratorKey();
  void _Slot23_GetCurrentAccessKey();
  void _Slot24_GetCurrentHasKeyboardFocus();
  void _Slot25_GetCurrentIsKeyboardFocusable();
  void _Slot26_GetCurrentIsEnabled();
  void _Slot27_GetCurrentAutomationId();
  void _Slot28_GetCurrentClassName();
  void _Slot29_GetCurrentHelpText();
  void _Slot30_GetCurrentCulture();
  void _Slot31_GetCurrentIsControlElement();
  void _Slot32_GetCurrentIsContentElement();
  void _Slot33_GetCurrentIsPassword();
  IntPtr get_CurrentNativeWindowHandle();
  void _Slot35_GetCurrentItemType();
  void _Slot36_GetCurrentIsOffscreen();
  void _Slot37_GetCurrentOrientation();
  void _Slot38_GetCurrentFrameworkId();
  void _Slot39_GetCurrentIsRequiredForForm();
  void _Slot40_GetCurrentItemStatus();
  RivetUiaRect get_CurrentBoundingRectangle();
  void _Slot42_GetCurrentLabeledBy();
  void _Slot43_GetCurrentAriaRole();
  void _Slot44_GetCurrentAriaProperties();
  void _Slot45_GetCurrentIsDataValidForForm();
  void _Slot46_GetCurrentControllerFor();
  void _Slot47_GetCurrentDescribedBy();
  void _Slot48_GetCurrentFlowsTo();
  void _Slot49_GetCurrentProviderDescription();
  void _Slot50_GetCachedProcessId();
  int get_CachedControlType();
  void _Slot52_GetCachedLocalizedControlType();
  [return: MarshalAs(UnmanagedType.BStr)] string get_CachedName();
  void _Slot54_GetCachedAcceleratorKey();
  void _Slot55_GetCachedAccessKey();
  void _Slot56_GetCachedHasKeyboardFocus();
  void _Slot57_GetCachedIsKeyboardFocusable();
  void _Slot58_GetCachedIsEnabled();
  void _Slot59_GetCachedAutomationId();
  void _Slot60_GetCachedClassName();
  void _Slot61_GetCachedHelpText();
  void _Slot62_GetCachedCulture();
  void _Slot63_GetCachedIsControlElement();
  void _Slot64_GetCachedIsContentElement();
  void _Slot65_GetCachedIsPassword();
  void _Slot66_GetCachedNativeWindowHandle();
  void _Slot67_GetCachedItemType();
  void _Slot68_GetCachedIsOffscreen();
  void _Slot69_GetCachedOrientation();
  void _Slot70_GetCachedFrameworkId();
  void _Slot71_GetCachedIsRequiredForForm();
  void _Slot72_GetCachedItemStatus();
  RivetUiaRect get_CachedBoundingRectangle();
}

[ComImport, Guid("30cbe57d-d9d0-452a-ab13-7ac5ac4825ee"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IUIAutomation {
  void _Slot01_CompareElements();
  void _Slot02_CompareRuntimeIds();
  IUIAutomationElement GetRootElement();
  IUIAutomationElement ElementFromHandle(IntPtr hwnd);
  void _Slot05_ElementFromPoint();
  void _Slot06_GetFocusedElement();
  void _Slot07_GetRootElementBuildCache();
  void _Slot08_ElementFromHandleBuildCache();
  void _Slot09_ElementFromPointBuildCache();
  void _Slot10_GetFocusedElementBuildCache();
  void _Slot11_CreateTreeWalker();
  void _Slot12_GetControlViewWalker();
  void _Slot13_GetContentViewWalker();
  void _Slot14_GetRawViewWalker();
  void _Slot15_GetRawViewCondition();
  IUIAutomationCondition get_ControlViewCondition();
  void _Slot17_GetContentViewCondition();
  IUIAutomationCacheRequest CreateCacheRequest();
  IUIAutomationCondition CreateTrueCondition();
  void _Slot20_CreateFalseCondition();
  IUIAutomationCondition CreatePropertyCondition(int propertyId, [MarshalAs(UnmanagedType.Struct)] object value);
  void _Slot22_CreatePropertyConditionEx();
  IUIAutomationCondition CreateAndCondition(IUIAutomationCondition condition1, IUIAutomationCondition condition2);
}

public static class RivetUia {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);

  // UIA property/pattern/controltype ids (UIAutomationClient.h constants).
  const int P_BoundingRectangle = 30001;
  const int P_ControlType = 30003;
  const int P_Name = 30005;
  const int P_ValueValue = 30045;
  const int PAT_Invoke = 10000;
  const int PAT_Value = 10002;
  const int PAT_ExpandCollapse = 10005;
  const int CT_MenuItem = 50011;
  const int TS_Children = 2;
  const int TS_Descendants = 4;

  static IUIAutomation _uia;
  static IUIAutomationCondition _ctrlView;
  static IUIAutomationCondition _trueCond;

  static IUIAutomation Uia() {
    if (_uia == null) {
      // CUIAutomation8 (Win8+) isolates hung providers; fall back to the
      // original CUIAutomation CLSID on Win7-era hosts.
      IUIAutomation inst = null;
      try {
        Type t8 = Type.GetTypeFromCLSID(new Guid("e22ad333-b25f-460c-83d0-0581107395c9"));
        inst = (IUIAutomation)Activator.CreateInstance(t8);
      } catch {
        Type t7 = Type.GetTypeFromCLSID(new Guid("ff48dba4-60ef-4201-aa87-54103eef594e"));
        inst = (IUIAutomation)Activator.CreateInstance(t7);
      }
      _ctrlView = inst.get_ControlViewCondition();
      _trueCond = inst.CreateTrueCondition();
      _uia = inst;
    }
    return _uia;
  }

  public static string Probe() {
    IUIAutomationElement root = Uia().GetRootElement();
    string name = null;
    try { name = root.get_CurrentName(); } catch {}
    return "com-ok:" + (name == null ? "" : name);
  }

  // ControlType id -> the managed ProgrammaticName suffix, so trees/refs stay
  // byte-compatible with the System.Windows.Automation path.
  static string RoleName(int ct) {
    switch (ct) {
      case 50000: return "Button";
      case 50001: return "Calendar";
      case 50002: return "CheckBox";
      case 50003: return "ComboBox";
      case 50004: return "Edit";
      case 50005: return "Hyperlink";
      case 50006: return "Image";
      case 50007: return "ListItem";
      case 50008: return "List";
      case 50009: return "Menu";
      case 50010: return "MenuBar";
      case 50011: return "MenuItem";
      case 50012: return "ProgressBar";
      case 50013: return "RadioButton";
      case 50014: return "ScrollBar";
      case 50015: return "Slider";
      case 50016: return "Spinner";
      case 50017: return "StatusBar";
      case 50018: return "Tab";
      case 50019: return "TabItem";
      case 50020: return "Text";
      case 50021: return "ToolBar";
      case 50022: return "ToolTip";
      case 50023: return "Tree";
      case 50024: return "TreeItem";
      case 50025: return "Custom";
      case 50026: return "Group";
      case 50027: return "Thumb";
      case 50028: return "DataGrid";
      case 50029: return "DataItem";
      case 50030: return "Document";
      case 50031: return "SplitButton";
      case 50032: return "Window";
      case 50033: return "Pane";
      case 50034: return "Header";
      case 50035: return "HeaderItem";
      case 50036: return "Table";
      case 50037: return "TitleBar";
      case 50038: return "Separator";
      case 50039: return "SemanticZoom";
      case 50040: return "AppBar";
      default: return "";
    }
  }

  // Manual JSON string escape — no Json.NET, no PS serializer quirks.
  static string J(string s) {
    if (s == null) return "\\"\\"";
    StringBuilder sb = new StringBuilder("\\"");
    for (int i = 0; i < s.Length; i++) {
      char c = s[i];
      if (c == '"') sb.Append("\\\\\\"");
      else if (c == '\\\\') sb.Append("\\\\\\\\");
      else if (c < ' ') sb.Append("\\\\u").Append(((int)c).ToString("x4"));
      else sb.Append(c);
    }
    return sb.Append('"').ToString();
  }

  static string Norm(string app) {
    string a = app.Trim();
    if (a.Length > 4 && a.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) a = a.Substring(0, a.Length - 4).Trim();
    return a;
  }

  class AppMatch {
    public List<IUIAutomationElement> wins = new List<IUIAutomationElement>();
    public IntPtr hwnd = IntPtr.Zero;
  }

  // Same two-pass semantics as the managed findApp snippet: process
  // name/main-window-title match first, then top-level UIA window Name
  // (exact, then substring; case-insensitive) for frame-hosted UWP apps.
  static AppMatch FindApp(string app) {
    AppMatch m = new AppMatch();
    string norm = Norm(app);
    IUIAutomationElement root = Uia().GetRootElement();
    IUIAutomationElementArray all = root.FindAll(TS_Children, _trueCond);
    int n = all.get_Length();
    Dictionary<int, bool> pids = new Dictionary<int, bool>();
    foreach (System.Diagnostics.Process p in System.Diagnostics.Process.GetProcesses()) {
      try {
        if (p.MainWindowHandle == IntPtr.Zero) continue;
        bool hit = string.Equals(p.ProcessName, norm, StringComparison.OrdinalIgnoreCase)
          || string.Equals(p.MainWindowTitle, norm, StringComparison.OrdinalIgnoreCase);
        if (hit) {
          pids[p.Id] = true;
          if (m.hwnd == IntPtr.Zero) m.hwnd = p.MainWindowHandle;
        }
      } catch {}
    }
    if (pids.Count > 0) {
      for (int i = 0; i < n; i++) {
        try {
          IUIAutomationElement w = all.GetElement(i);
          if (pids.ContainsKey(w.get_CurrentProcessId())) m.wins.Add(w);
        } catch {}
      }
    }
    if (m.wins.Count == 0) {
      m.hwnd = IntPtr.Zero;
      string needle = norm.ToLowerInvariant();
      List<IUIAutomationElement> exact = new List<IUIAutomationElement>();
      List<IUIAutomationElement> sub = new List<IUIAutomationElement>();
      for (int i = 0; i < n; i++) {
        try {
          IUIAutomationElement w = all.GetElement(i);
          string name = w.get_CurrentName();
          if (string.IsNullOrEmpty(name)) continue;
          string ln = name.ToLowerInvariant();
          if (ln == needle) exact.Add(w);
          else if (ln.Contains(needle)) sub.Add(w);
        } catch {}
      }
      m.wins = exact.Count > 0 ? exact : sub;
      if (m.wins.Count > 0) {
        try { m.hwnd = m.wins[0].get_CurrentNativeWindowHandle(); } catch {}
      }
    }
    return m;
  }

  static AppMatch FindAppOrThrow(string app) {
    AppMatch m = FindApp(app);
    if (m.wins.Count == 0) throw new Exception("no running app named '" + Norm(app) + "' with a window (use list_apps for exact names)");
    return m;
  }

  public static long ResolveHwnd(string app) {
    return FindAppOrThrow(app).hwnd.ToInt64();
  }

  public static string ListAppsJson() {
    IntPtr fg = GetForegroundWindow();
    uint fgPid = 0;
    GetWindowThreadProcessId(fg, out fgPid);
    SortedDictionary<string, string[]> byName = new SortedDictionary<string, string[]>(StringComparer.OrdinalIgnoreCase);
    Dictionary<int, bool> afhPids = new Dictionary<int, bool>();
    foreach (System.Diagnostics.Process p in System.Diagnostics.Process.GetProcesses()) {
      try {
        if (string.Equals(p.ProcessName, "ApplicationFrameHost", StringComparison.OrdinalIgnoreCase)) { afhPids[p.Id] = true; continue; }
        if (p.MainWindowHandle == IntPtr.Zero) continue;
        string title = p.MainWindowTitle;
        if (string.IsNullOrEmpty(title)) continue;
        bool isFg = p.Id == (int)fgPid;
        string[] cur;
        if (!byName.TryGetValue(p.ProcessName, out cur)) byName[p.ProcessName] = new string[] { title, isFg ? "1" : "0" };
        else if (isFg) { cur[0] = title; cur[1] = "1"; }
      } catch {}
    }
    StringBuilder sb = new StringBuilder("[");
    bool first = true;
    foreach (KeyValuePair<string, string[]> kv in byName) {
      if (!first) sb.Append(",");
      first = false;
      sb.Append("{\\"name\\":").Append(J(kv.Key)).Append(",\\"title\\":").Append(J(kv.Value[0]))
        .Append(",\\"frontmost\\":").Append(kv.Value[1] == "1" ? "true" : "false").Append("}");
    }
    if (afhPids.Count > 0) {
      IUIAutomationElement root = Uia().GetRootElement();
      IUIAutomationElementArray all = root.FindAll(TS_Children, _trueCond);
      int n = all.get_Length();
      for (int i = 0; i < n; i++) {
        try {
          IUIAutomationElement w = all.GetElement(i);
          if (!afhPids.ContainsKey(w.get_CurrentProcessId())) continue;
          string nm = w.get_CurrentName();
          if (string.IsNullOrEmpty(nm)) continue;
          bool isFg = false;
          try { isFg = w.get_CurrentNativeWindowHandle() == fg; } catch {}
          if (!first) sb.Append(",");
          first = false;
          sb.Append("{\\"name\\":").Append(J(nm)).Append(",\\"title\\":\\"\\",\\"frontmost\\":").Append(isFg ? "true" : "false").Append("}");
        } catch {}
      }
    }
    return sb.Append("]").ToString();
  }

  class SnapState {
    public StringBuilder sb;
    public int refN;
    public int count;
    public int max;
    public IUIAutomationCacheRequest cr;
    public bool first;
  }

  static readonly Dictionary<string, bool> SkipValue = new Dictionary<string, bool> {
    { "Window", true }, { "Pane", true }, { "Group", true }, { "Tree", true }, { "List", true },
    { "Table", true }, { "DataGrid", true }, { "DataItem", true }, { "ToolBar", true },
    { "TitleBar", true }, { "MenuBar", true }, { "Menu", true }, { "Tab", true },
    { "ScrollBar", true }, { "Header", true }
  };
  static readonly Dictionary<string, bool> NoDescend = new Dictionary<string, bool> {
    { "ScrollBar", true }, { "TitleBar", true }
  };

  static void Visit(SnapState st, IUIAutomationElement el, int depth, string path) {
    if (st.count >= st.max) return;
    string role = ""; string title = ""; string value = "";
    try { role = RoleName(el.get_CachedControlType()); } catch {}
    try { string t = el.get_CachedName(); if (t != null) title = t; } catch {}
    if (!SkipValue.ContainsKey(role)) {
      try {
        object po = el.GetCachedPattern(PAT_Value);
        if (po != null) {
          string v = ((IUIAutomationValuePattern)po).get_CachedValue();
          if (v != null) value = v;
        }
      } catch {}
    }
    if (role.Length > 0 || title.Length > 0 || value.Length > 0) {
      st.refN++;
      st.count++;
      string pos = "null";
      try {
        RivetUiaRect r = el.get_CachedBoundingRectangle();
        if (r.right > r.left && r.bottom > r.top) pos = "{\\"x\\":" + r.left + ",\\"y\\":" + r.top + "}";
      } catch {}
      if (!st.first) st.sb.Append(",");
      st.first = false;
      st.sb.Append("{\\"ref\\":").Append(st.refN)
        .Append(",\\"depth\\":").Append(depth)
        .Append(",\\"role\\":").Append(J(role))
        .Append(",\\"title\\":").Append(J(title))
        .Append(",\\"value\\":").Append(J(value))
        .Append(",\\"pos\\":").Append(pos)
        .Append(",\\"path\\":[").Append(path).Append("]}");
    }
    if (NoDescend.ContainsKey(role)) return;
    IUIAutomationElementArray kids = null;
    try { kids = el.FindAllBuildCache(TS_Children, _ctrlView, st.cr); } catch { return; }
    if (kids == null) return;
    int len = 0;
    try { len = kids.get_Length(); } catch { return; }
    for (int k = 0; k < len; k++) {
      if (st.count >= st.max) break;
      IUIAutomationElement kid = null;
      try { kid = kids.GetElement(k); } catch { continue; }
      Visit(st, kid, depth + 1, path + "," + k);
    }
  }

  public static string SnapshotJson(string app, int maxNodes) {
    AppMatch m = FindAppOrThrow(app);
    IUIAutomation uia = Uia();
    IUIAutomationCacheRequest cr = uia.CreateCacheRequest();
    cr.AddProperty(P_Name);
    cr.AddProperty(P_ControlType);
    cr.AddProperty(P_BoundingRectangle);
    cr.AddPattern(PAT_Value);
    cr.AddProperty(P_ValueValue);
    cr.put_TreeFilter(_ctrlView);
    SnapState st = new SnapState();
    st.sb = new StringBuilder("[");
    st.max = maxNodes;
    st.cr = cr;
    st.first = true;
    for (int i = 0; i < m.wins.Count; i++) {
      IUIAutomationElement w = null;
      try { w = m.wins[i].BuildUpdatedCache(cr); } catch { continue; }
      Visit(st, w, 0, i.ToString());
    }
    return st.sb.Append("]").ToString();
  }

  // Child-index resolution with identity check. Stale messages render
  // byte-identically to the managed resolveByPath — tool.ts self-heal keys
  // off the "stale snapshot" marker.
  static IUIAutomationElement ResolveByPath(List<IUIAutomationElement> wins, string pathCsv, string expectRole, string expectTitle) {
    string[] parts = pathCsv.Split(new char[] { ',' }, StringSplitOptions.RemoveEmptyEntries);
    if (parts.Length == 0) throw new Exception("stale snapshot - window index out of range, re-snapshot first");
    int wi = int.Parse(parts[0]);
    if (wi >= wins.Count) throw new Exception("stale snapshot - window index out of range, re-snapshot first");
    IUIAutomationElement el = wins[wi];
    for (int i = 1; i < parts.Length; i++) {
      int idx = int.Parse(parts[i]);
      IUIAutomationElementArray kids = null;
      try { kids = el.FindAll(TS_Children, _ctrlView); } catch {}
      int len = 0;
      if (kids != null) { try { len = kids.get_Length(); } catch {} }
      if (idx >= len) throw new Exception("stale snapshot - element path no longer valid, re-snapshot first");
      el = kids.GetElement(idx);
    }
    string role = ""; string title = "";
    try { role = RoleName(el.get_CurrentControlType()); } catch {}
    try { string t = el.get_CurrentName(); if (t != null) title = t; } catch {}
    if (expectRole.Length > 0 && role != expectRole) throw new Exception("stale snapshot - element role changed (" + role + " != " + expectRole + "), re-snapshot first");
    if (expectTitle.Length > 0 && title != expectTitle) throw new Exception("stale snapshot - element title changed, re-snapshot first");
    return el;
  }

  public static string LocateJson(string app, string pathCsv, string role, string title) {
    AppMatch m = FindAppOrThrow(app);
    IUIAutomationElement el = ResolveByPath(m.wins, pathCsv, role, title);
    RivetUiaRect r = el.get_CurrentBoundingRectangle();
    if (r.right <= r.left || r.bottom <= r.top) throw new Exception("element has no on-screen position");
    return "{\\"x\\":" + ((r.left + r.right) / 2) + ",\\"y\\":" + ((r.top + r.bottom) / 2) + "}";
  }

  // Left single click gets the InvokePattern fast path (works even for
  // obscured elements); otherwise PS synthesizes input at the center.
  public static string ClickTargetJson(string app, string pathCsv, string role, string title, bool allowInvoke) {
    AppMatch m = FindAppOrThrow(app);
    IUIAutomationElement el = ResolveByPath(m.wins, pathCsv, role, title);
    if (allowInvoke) {
      object po = null;
      try { po = el.GetCurrentPattern(PAT_Invoke); } catch {}
      if (po != null) {
        ((IUIAutomationInvokePattern)po).Invoke();
        return "{\\"invoked\\":true,\\"x\\":0,\\"y\\":0}";
      }
    }
    RivetUiaRect r = el.get_CurrentBoundingRectangle();
    if (r.right <= r.left || r.bottom <= r.top) throw new Exception("element has no on-screen position");
    return "{\\"invoked\\":false,\\"x\\":" + ((r.left + r.right) / 2) + ",\\"y\\":" + ((r.top + r.bottom) / 2) + "}";
  }

  public static void SetValue(string app, string pathCsv, string role, string title, string text) {
    AppMatch m = FindAppOrThrow(app);
    IUIAutomationElement el = ResolveByPath(m.wins, pathCsv, role, title);
    object po = null;
    try { po = el.GetCurrentPattern(PAT_Value); } catch {}
    if (po == null) throw new Exception("element does not accept direct value writes - click it and use type/paste_text instead");
    ((IUIAutomationValuePattern)po).SetValue(text);
  }

  // Menu walk: Expand/Invoke level by level; popups often parent to the
  // desktop, so after the first level misses are retried from the root. A
  // miss lists what IS available for self-correction. Returns {"done":true}
  // or the center of a non-invokable final item for PS to click.
  public static string MenuSelectJson(string app, string segmentsJoined) {
    AppMatch m = FindAppOrThrow(app);
    IUIAutomation uia = Uia();
    string[] segments = segmentsJoined.Split(new char[] { '\\n' }, StringSplitOptions.RemoveEmptyEntries);
    IUIAutomationCondition menuItemCond = uia.CreatePropertyCondition(P_ControlType, CT_MenuItem);
    IUIAutomationElement scope = m.wins[0];
    IUIAutomationElement root = uia.GetRootElement();
    for (int i = 0; i < segments.Length; i++) {
      string seg = segments[i];
      IUIAutomationCondition cond = uia.CreateAndCondition(menuItemCond, uia.CreatePropertyCondition(P_Name, seg));
      IUIAutomationElement item = null;
      try { item = scope.FindFirst(TS_Descendants, cond); } catch {}
      if (item == null && i > 0) { try { item = root.FindFirst(TS_Descendants, cond); } catch {} }
      if (item == null && i > 0) {
        System.Threading.Thread.Sleep(250);
        try { item = scope.FindFirst(TS_Descendants, cond); } catch {}
        if (item == null) { try { item = root.FindFirst(TS_Descendants, cond); } catch {} }
      }
      if (item == null) {
        List<string> names = new List<string>();
        try {
          IUIAutomationElementArray allItems = scope.FindAll(TS_Descendants, menuItemCond);
          int len = allItems.get_Length();
          for (int k = 0; k < len; k++) {
            try {
              string nm = allItems.GetElement(k).get_CurrentName();
              if (!string.IsNullOrEmpty(nm)) names.Add(nm);
            } catch {}
          }
        } catch {}
        throw new Exception("menu item '" + seg + "' not found; available: " + string.Join(", ", names.ToArray()));
      }
      object expand = null; object invoke = null;
      try { expand = item.GetCurrentPattern(PAT_ExpandCollapse); } catch {}
      try { invoke = item.GetCurrentPattern(PAT_Invoke); } catch {}
      bool last = i == segments.Length - 1;
      if (!last) {
        if (expand != null) ((IUIAutomationExpandCollapsePattern)expand).Expand();
        else if (invoke != null) ((IUIAutomationInvokePattern)invoke).Invoke();
        System.Threading.Thread.Sleep(250);
        scope = item;
      } else {
        if (invoke != null) ((IUIAutomationInvokePattern)invoke).Invoke();
        else if (expand != null) ((IUIAutomationExpandCollapsePattern)expand).Expand();
        else {
          RivetUiaRect r = item.get_CurrentBoundingRectangle();
          if (r.right <= r.left || r.bottom <= r.top) throw new Exception("menu item '" + seg + "' is not invokable and has no position");
          return "{\\"done\\":false,\\"x\\":" + ((r.left + r.right) / 2) + ",\\"y\\":" + ((r.top + r.bottom) / 2) + "}";
        }
      }
    }
    return "{\\"done\\":true,\\"x\\":0,\\"y\\":0}";
  }
}
'@
}
`

/** Rethrow the innermost exception so PS error text is the clean C# message
 *  (MethodInvocationException wrapping would bloat model-facing errors). */
function comTry(body: string): string {
  return `
try {
${body}
} catch { throw $_.Exception.GetBaseException() }
`
}

/** App resolution for input-only builders: sets $app and $fh (the managed
 *  findApp contract) via one C# call. */
export function comResolveSnippet(app: string): string {
  const name = psString(normalizeAppName(app))
  return `
$app = ${name}
${comTry(`$fh = [IntPtr][RivetUia]::ResolveHwnd($app)`)}
`
}

// --- COM script builders (exported for unit tests) ---

export function buildComProbeScript(): string {
  return `
${UIA_COM_PRELUDE}
[RivetUia]::Probe()
`
}

export function buildComListAppsScript(): string {
  return `
${UIA_COM_PRELUDE}
${comTry(`[RivetUia]::ListAppsJson()`)}
`
}

export function buildComSnapshotScript(app: string, outFull: string, outVision: string, screenshot = true, maxNodes = 400): string {
  const name = psString(normalizeAppName(app))
  const shotSection = screenshot
    ? `
$shotOk = $false
try {
  $fh = [IntPtr][RivetUia]::ResolveHwnd(${name})
  Add-Type -AssemblyName System.Drawing | Out-Null
  $wrct = New-Object 'RivetInput+RECT'
  if ($fh -ne [IntPtr]::Zero -and [RivetInput]::GetWindowRect($fh, [ref]$wrct)) {
    $sx = $wrct.Left; $sy = $wrct.Top; $sw = $wrct.Right - $wrct.Left; $sh = $wrct.Bottom - $wrct.Top
    if ($sw -gt 0 -and $sh -gt 0) {
      $bmp = New-Object System.Drawing.Bitmap($sw, $sh)
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.CopyFromScreen($sx, $sy, 0, 0, (New-Object System.Drawing.Size($sw, $sh)))
      $g.Dispose()
      $bmp.Save(${psString(outFull)}, [System.Drawing.Imaging.ImageFormat]::Png)
      $maxDim = ${VISION_MAX_DIMENSION}
      if ($sw -gt $maxDim -or $sh -gt $maxDim) {
        $scale = [math]::Min($maxDim / $sw, $maxDim / $sh)
        $nw = [math]::Max(1, [int]($sw * $scale)); $nh = [math]::Max(1, [int]($sh * $scale))
        $small = New-Object System.Drawing.Bitmap($bmp, $nw, $nh)
        $small.Save(${psString(outVision)}, [System.Drawing.Imaging.ImageFormat]::Png)
        $small.Dispose()
      }
      $bmp.Dispose()
      $shotOk = $true
    }
  }
} catch { $shotOk = $false }`
    : `
$shotOk = $false`
  return `
${INPUT_PRELUDE}
${UIA_COM_PRELUDE}
${comTry(`$rowsJson = [RivetUia]::SnapshotJson(${name}, ${maxNodes})`)}
${shotSection}
'{"rows":' + $rowsJson + ',"shot":' + $(if ($shotOk) { 'true' } else { 'false' }) + '}'
`
}

export function buildComClickByPathScript(
  app: string,
  target: { path: number[]; role?: string; title?: string },
  button: 'left' | 'right',
  count: 1 | 2,
): string {
  const allowInvoke = button === 'left' && count === 1
  return `
${INPUT_PRELUDE}
${UIA_COM_PRELUDE}
${comTry(`$info = [RivetUia]::ClickTargetJson(${psString(normalizeAppName(app))}, ${psString(target.path.join(','))}, ${psString(target.role ?? '')}, ${psString(target.title ?? '')}, $${allowInvoke}) | ConvertFrom-Json`)}
if (-not $info.invoked) {
  [RivetInput]::Click([int]$info.x, [int]$info.y, $${button === 'right'}, ${count})
}
'ok'
`
}

export function buildComLocateScript(app: string, target: { path: number[]; role?: string; title?: string }): string {
  return `
${UIA_COM_PRELUDE}
${comTry(`[RivetUia]::LocateJson(${psString(normalizeAppName(app))}, ${psString(target.path.join(','))}, ${psString(target.role ?? '')}, ${psString(target.title ?? '')})`)}
`
}

export function buildComSetValueScript(
  app: string,
  target: { path: number[]; role?: string; title?: string },
  text: string,
): string {
  const b64 = Buffer.from(text, 'utf8').toString('base64')
  return `
${UIA_COM_PRELUDE}
$text = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${psString(b64)}))
${comTry(`[RivetUia]::SetValue(${psString(normalizeAppName(app))}, ${psString(target.path.join(','))}, ${psString(target.role ?? '')}, ${psString(target.title ?? '')}, $text)`)}
'ok'
`
}

export function buildComMenuSelectScript(app: string, path: string[]): string {
  // Segments travel base64-joined-by-newline: quoting/CJK-safe and no JSON
  // parsing needed on the C# side.
  const b64 = Buffer.from(path.join('\n'), 'utf8').toString('base64')
  return `
${INPUT_PRELUDE}
${UIA_COM_PRELUDE}
${comResolveSnippet(app)}
${FOCUS_WINDOW}
Start-Sleep -Milliseconds 150
$segs = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${psString(b64)}))
${comTry(`$res = [RivetUia]::MenuSelectJson($app, $segs) | ConvertFrom-Json`)}
if (-not $res.done) {
  [RivetInput]::Click([int]$res.x, [int]$res.y, $false, 1)
}
'ok'
`
}

export function buildComFocusAppScript(app: string): string {
  return `
${INPUT_PRELUDE}
${UIA_COM_PRELUDE}
${comResolveSnippet(app)}
${FOCUS_WINDOW}
'ok'
`
}

export function buildComLaunchAppScript(app: string): string {
  return `
${INPUT_PRELUDE}
${UIA_COM_PRELUDE}
$app = ${psString(normalizeAppName(app))}
$fh = [IntPtr]::Zero
$running = $false
try { $fh = [IntPtr][RivetUia]::ResolveHwnd($app); $running = $true } catch {}
if (-not $running) {
  Start-Process -FilePath $app | Out-Null
  for ($try = 0; $try -lt 40; $try++) {
    Start-Sleep -Milliseconds 250
    try { $fh = [IntPtr][RivetUia]::ResolveHwnd($app); $running = $true; break } catch {}
  }
  if (-not $running) { throw "$app did not show a window within 10s" }
}
${FOCUS_WINDOW}
'ok'
`
}

export function buildComTypeScript(app: string, text: string): string {
  return `
${INPUT_PRELUDE}
${UIA_COM_PRELUDE}
${comResolveSnippet(app)}
${typeBodySnippet(text)}
'ok'
`
}

export function buildComKeyScript(app: string, spec: ComboKeySpec): string {
  return `
${INPUT_PRELUDE}
${UIA_COM_PRELUDE}
${comResolveSnippet(app)}
${keyBodySnippet(spec)}
'ok'
`
}

export function buildComPasteTextScript(app: string, text: string): string {
  return `
${INPUT_PRELUDE}
${UIA_COM_PRELUDE}
${comResolveSnippet(app)}
${pasteBodySnippet(text)}
'ok'
`
}

export function buildComScrollScript(app: string, opts: ScrollOptions): string {
  const amount = Math.max(1, Math.min(50, Math.round(opts.amount ?? 5)))
  const delta = (opts.direction === 'up' || opts.direction === 'right' ? 1 : -1) * amount * 120
  const horizontal = opts.direction === 'left' || opts.direction === 'right'
  const atSnippet = opts.at
    ? `$ax = ${Math.round(opts.at.x)}; $ay = ${Math.round(opts.at.y)}`
    : `
${UIA_COM_PRELUDE}
${comResolveSnippet(app)}
${SCROLL_WINDOW_CENTER}`
  return `
${INPUT_PRELUDE}
${atSnippet}
[RivetInput]::Wheel($ax, $ay, ${delta}, $${horizontal})
'ok'
`
}

// --- session-level probe state ---

type ComState = 'unknown' | 'ok' | 'broken'
let comState: ComState = 'unknown'

/** Test hook: forget the probe result so the next call re-probes. */
export function resetComStateForTests(): void {
  comState = 'unknown'
}

export function comEnabled(): boolean {
  return process.env.RIVET_CU_COM !== '0'
}

/**
 * One-time per-process COM availability probe: compiles the prelude and
 * touches the UIA root. Any failure (compile error, CLSID missing, COM init)
 * marks the session broken and the driver stays on the managed path.
 */
export async function comReady(run: PowerShellRunner): Promise<boolean> {
  if (!comEnabled()) return false
  if (comState === 'unknown') {
    try {
      const out = await run(buildComProbeScript(), 20_000)
      comState = out.includes('com-ok') ? 'ok' : 'broken'
    } catch {
      comState = 'broken'
    }
  }
  return comState === 'ok'
}
