param([ValidateSet('Inspect', 'Toggle', 'Quit')][string]$Action = 'Inspect', [int]$AppProcessId = 0)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class TrayInput {
    public delegate bool Callback(IntPtr handle, IntPtr data);
    [DllImport("user32.dll")] public static extern bool EnumWindows(Callback callback, IntPtr data);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr handle, StringBuilder text, int size);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint id);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern int GetMenuItemCount(IntPtr menu);
    [DllImport("user32.dll")] public static extern uint GetMenuItemID(IntPtr menu, int index);
    public static uint ItemId(IntPtr window, int index) { return GetMenuItemID(SendMessage(window, 0x01e1, IntPtr.Zero, IntPtr.Zero), index); }
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetMenuString(IntPtr menu, uint index, StringBuilder text, int size, uint flags);
    public static string[] Labels(IntPtr window) {
        var menu = SendMessage(window, 0x01e1, IntPtr.Zero, IntPtr.Zero);
        int count = GetMenuItemCount(menu);
        var labels = new string[Math.Max(0, count)];
        for (uint i=0; i<count; i++) { var text=new StringBuilder(256); GetMenuString(menu,i,text,256,0x400); labels[i]=text.ToString(); }
        return labels;
    }
    public static IntPtr FindMenu(int processId) {
        IntPtr result=IntPtr.Zero;
        EnumWindows((handle,_)=>{var text=new StringBuilder(256);GetClassName(handle,text,256);uint id;GetWindowThreadProcessId(handle,out id);if(text.ToString()=="#32768" && (processId==0 || processId==id)){result=handle;return false;}return true;},IntPtr.Zero);
        return result;
    }
    public static IntPtr Find(int processId) {
        IntPtr result = IntPtr.Zero;
        EnumWindows((handle, _) => {
            var text = new StringBuilder(256); GetClassName(handle, text, 256);
            uint id; GetWindowThreadProcessId(handle, out id);
            if (text.ToString() == "tray_icon_app" && (processId == 0 || processId == id)) { result = handle; return false; }
            return true;
        }, IntPtr.Zero);
        return result;
    }
}
'@
$root = [System.Windows.Automation.AutomationElement]::RootElement
$children = [System.Windows.Automation.TreeScope]::Children
$descendants = [System.Windows.Automation.TreeScope]::Descendants
$all = [System.Windows.Automation.Condition]::TrueCondition
$text = '{"overflow":"\u663e\u793a\u9690\u85cf\u7684\u56fe\u6807","start":"\u5f00\u59cb\u68c0\u6d4b","cancel":"\u53d6\u6d88\u8fde\u63a5","stop":"\u505c\u6b62\u68c0\u6d4b","quit":"\u9000\u51fa"}' | ConvertFrom-Json
function Find-Class([string]$className) {
    $root.FindFirst($children, [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ClassNameProperty, $className))
}
$handle = [TrayInput]::Find($AppProcessId)
if ($handle -eq [IntPtr]::Zero) { throw 'The application tray window was not found' }
# Open the real native menu with the tray library's right-click notification.
[void][TrayInput]::PostMessage($handle, 6002, [IntPtr]::Zero, [IntPtr]::new(0x205))
    $menu = [IntPtr]::Zero
    $labels = @()
    for ($attempt = 0; $attempt -lt 20 -and !$labels.Count; $attempt++) {
        Start-Sleep -Milliseconds 100
        $menu = [TrayInput]::FindMenu($AppProcessId)
        if ($menu -ne [IntPtr]::Zero) { $labels = @([TrayInput]::Labels($menu)) }
    }
    if (!$labels.Count) { throw 'Tray menu was not found' }
    if ($Action -eq 'Inspect') {
        [void][TrayInput]::PostMessage($handle, 0x1f, [IntPtr]::Zero, [IntPtr]::Zero)
    } else {
        $index = -1
        for ($i=0; $i -lt $labels.Count; $i++) {
            if (($Action -eq 'Quit' -and $labels[$i] -eq $text.quit) -or ($Action -eq 'Toggle' -and $labels[$i] -in @($text.start, $text.cancel, $text.stop))) { $index=$i; break }
        }
        if ($index -lt 0) { throw "Requested tray action was not found: $Action" }
        $itemId = [TrayInput]::ItemId($menu, $index)
        [void][TrayInput]::PostMessage($handle, 0x1f, [IntPtr]::Zero, [IntPtr]::Zero)
        [void][TrayInput]::PostMessage($handle, 0x111, [IntPtr]::new($itemId), [IntPtr]::Zero)
    }
    [pscustomobject]@{ labels = $labels; action = $Action } | ConvertTo-Json -Compress
