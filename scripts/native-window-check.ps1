param([switch]$ShowMain, [switch]$CloseMain, [int]$TargetProcessId = 0)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public static class SentinelWindows {
    public delegate bool Callback(IntPtr handle, IntPtr data);
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool EnumWindows(Callback callback, IntPtr data);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr handle, StringBuilder text, int size);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr handle, int index);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr handle, out Rect rect);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr handle, int mode);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr handle, StringBuilder text, int size);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    public static string Title(IntPtr handle) { var text = new StringBuilder(512); GetWindowText(handle, text, 512); return text.ToString(); }
    public static string Class(IntPtr handle) { var text = new StringBuilder(256); GetClassName(handle, text, 256); return text.ToString(); }
    public static IntPtr[] Taskbars() {
        var handles = new List<IntPtr>();
        EnumWindows((handle, _) => { if (Class(handle) == "Shell_TrayWnd" || Class(handle) == "Shell_SecondaryTrayWnd") handles.Add(handle); return true; }, IntPtr.Zero);
        return handles.ToArray();
    }
    public static IntPtr[] Find() {
        var handles = new List<IntPtr>();
        EnumWindows((handle, _) => { if (Title(handle).StartsWith("Moyu Sentinel") || Title(handle) == "Moyu Automation Window Fixture") handles.Add(handle); return true; }, IntPtr.Zero);
        return handles.ToArray();
    }
}
'@
[void][SentinelWindows]::SetProcessDPIAware()
[void][SentinelWindows]::SetThreadDpiAwarenessContext([IntPtr]::new(-4))
$windows = @()
foreach ($handle in [SentinelWindows]::Find()) {
    [uint32]$windowProcessId = 0
    [void][SentinelWindows]::GetWindowThreadProcessId($handle, [ref]$windowProcessId)
    if ($TargetProcessId -and $windowProcessId -ne $TargetProcessId) { continue }
    $title = [SentinelWindows]::Title($handle)
    if ($CloseMain -and $title.StartsWith('Moyu Sentinel -')) {
        [void][SentinelWindows]::PostMessage($handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
    }
    if ($ShowMain -and $title.StartsWith('Moyu Sentinel -')) {
        [void][SentinelWindows]::ShowWindow($handle, 9)
        [void][SentinelWindows]::SetForegroundWindow($handle)
    }
    $rect = New-Object SentinelWindows+Rect
    [void][SentinelWindows]::GetWindowRect($handle, [ref]$rect)
    $style = [SentinelWindows]::GetWindowLong($handle, -20)
    $windows += [pscustomobject]@{
        title = $title; handle = $handle.ToInt64(); visible = [SentinelWindows]::IsWindowVisible($handle)
        topmost = ($style -band 8) -ne 0; transparent = ($style -band 32) -ne 0
        layered = ($style -band 524288) -ne 0; noActivate = ($style -band 134217728) -ne 0
        x = $rect.Left; y = $rect.Top; width = $rect.Right - $rect.Left; height = $rect.Bottom - $rect.Top
    }
}
$screens = @()
foreach ($screen in [System.Windows.Forms.Screen]::AllScreens) {
    $bounds = $screen.Bounds
    $points = @(
        @(($bounds.Left + 8), ($bounds.Top + [int]($bounds.Height / 2))),
        @(($bounds.Right - 9), ($bounds.Top + [int]($bounds.Height / 2))),
        @(($bounds.Left + [int]($bounds.Width / 2)), ($bounds.Top + 8)),
        @(($bounds.Left + [int]($bounds.Width / 2)), ($bounds.Bottom - 9))
    )
    $pixels = @()
    foreach ($point in $points) {
        $bitmap = New-Object System.Drawing.Bitmap(1, 1)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.CopyFromScreen($point[0], $point[1], 0, 0, [System.Drawing.Size]::new(1, 1))
        $color = $bitmap.GetPixel(0, 0)
        $pixels += [pscustomobject]@{ r = [int]$color.R; g = [int]$color.G; b = [int]$color.B }
        $graphics.Dispose()
        $bitmap.Dispose()
    }
    $area = $screen.WorkingArea
    $screens += [pscustomobject]@{ x = $bounds.X; y = $bounds.Y; width = $bounds.Width; height = $bounds.Height; pixels = $pixels; primary = $screen.Primary; workArea = @{ x = $area.X; y = $area.Y; width = $area.Width; height = $area.Height } }
}
$taskbars = @()
foreach ($handle in [SentinelWindows]::Taskbars()) {
    $rect = New-Object SentinelWindows+Rect
    [void][SentinelWindows]::GetWindowRect($handle, [ref]$rect)
    $taskbars += [pscustomobject]@{
        handle = $handle.ToInt64(); visible = [SentinelWindows]::IsWindowVisible($handle)
        topmost = ([SentinelWindows]::GetWindowLong($handle, -20) -band 8) -ne 0
        x = $rect.Left; y = $rect.Top; width = $rect.Right - $rect.Left; height = $rect.Bottom - $rect.Top
    }
}
[pscustomobject]@{ windows = $windows; screens = $screens; taskbars = $taskbars; foreground = [SentinelWindows]::GetForegroundWindow().ToInt64() } | ConvertTo-Json -Depth 5 -Compress
