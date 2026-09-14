# Packaged-exe end-to-end verification (ASCII only: Windows PowerShell 5.1 reads .ps1 as ANSI)
# 1) launch portable exe  2) find the MAIN window (largest visible)  3) capture real desktop screenshot
# 4) read runtime state (logs/screenshots watchers)  5) close main window via WM_CLOSE and count leftovers
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
$exe = (Get-ChildItem (Join-Path $repo 'dist') -Filter '*.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
$wrapper = [System.IO.Path]::GetFileNameWithoutExtension($exe)
$inner = $wrapper -replace '-\d+(\.\d+)*$', ''
$names = @($wrapper, $inner) | Select-Object -Unique
$state = Join-Path $env:APPDATA 'tarkov-offline-map\state.json'
$shot = Join-Path $repo 'build\verify-exe.png'

function Get-AppProcs {
  $out = @()
  foreach ($n in $names) { $out += @(Get-Process -Name $n -ErrorAction SilentlyContinue) }
  return $out
}
$sig = @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WinEnum {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public class Info { public IntPtr H; public uint Pid; public int W; public int Hh; public bool Visible; }
  public static List<Info> List(uint targetPid) {
    var res = new List<Info>();
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (targetPid != 0 && pid != targetPid) return true;
      RECT r; GetWindowRect(h, out r);
      res.Add(new Info { H = h, Pid = pid, W = r.Right - r.Left, Hh = r.Bottom - r.Top, Visible = IsWindowVisible(h) });
      return true;
    }, IntPtr.Zero);
    return res;
  }
}
"@
Add-Type -TypeDefinition $sig -Language CSharp
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

Write-Host "[verify] exe = $exe"
if (Test-Path $state) { Remove-Item $state -Force }
Get-AppProcs | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

Start-Process -FilePath $exe | Out-Null
Start-Sleep -Seconds 15

$procs = Get-AppProcs
Write-Host ("[verify] running processes = {0}" -f $procs.Count)
$wins = @()
foreach ($q in $procs) { $wins += @([WinEnum]::List([uint32]$q.Id)) }
$vis = @($wins | Where-Object { $_.Visible } | Sort-Object -Property W -Descending)
foreach ($w in $vis) { Write-Host ("[verify] visible window pid={0} hwnd={1} size={2}x{3}" -f $w.Pid, $w.H, $w.W, $w.Hh) }
$main = $vis | Select-Object -First 1
if ($main) {
  [WinEnum]::ShowWindow($main.H, 3) | Out-Null
  [WinEnum]::SetForegroundWindow($main.H) | Out-Null
  Start-Sleep -Seconds 3
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
  $bmp.Save($shot, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Host ("[verify] screenshot -> {0}" -f $shot)
}

if (Test-Path $state) {
  $j = Get-Content $state -Raw -Encoding UTF8 | ConvertFrom-Json
  $pos = if ($j.position) { "$($j.position.x),$($j.position.y),$($j.position.z)" } else { '-' }
  Write-Host ("[verify] state: mapKey={0} source={1} log={2} shot={3} pos={4}" -f $j.mapKey, $j.lastMapSource, $j.logWatcher.state, $j.shotWatcher.state, $pos)
  Write-Host ("[verify] session = {0}" -f $j.logWatcher.session)
} else { Write-Host '[verify] WARN: state.json not written' }

if ($main) {
  [WinEnum]::PostMessage($main.H, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
  Write-Host '[verify] sent WM_CLOSE to MAIN window'
}
Start-Sleep -Seconds 8
$left = Get-AppProcs
Write-Host ("[verify] leftover processes after closing MAIN window = {0}" -f $left.Count)
foreach ($q in $left) { Write-Host ("[verify]   leftover {0} pid={1}" -f $q.ProcessName, $q.Id) }
