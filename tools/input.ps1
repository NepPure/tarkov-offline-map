param(
  [Parameter(Mandatory = $true)][string]$Action,
  [int]$X = 0,
  [int]$Y = 0,
  [int]$Delta = 120
)
# Real-mouse input helper for verification (SetCursorPos / mouse_event = system-level input,
# not synthetic DOM events).
#
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads .ps1 as ANSI/GBK, so a
# UTF-8 Chinese comment can swallow the following line and silently break the script.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/input.ps1 foreground
#   powershell ... -File tools/input.ps1 cursor
#   powershell ... -File tools/input.ps1 move  -X 100 -Y 200
#   powershell ... -File tools/input.ps1 click -X 100 -Y 200
#   powershell ... -File tools/input.ps1 wheel -X 100 -Y 200 -Delta 120    # zoom in
#   powershell ... -File tools/input.ps1 wheel -X 100 -Y 200 -Delta -120   # zoom out
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace TkInput -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, System.UIntPtr dwExtraInfo);
[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint pid);
'@

function Get-CursorText {
  $p = [System.Windows.Forms.Cursor]::Position
  "$($p.X),$($p.Y)"
}

function Move-Cursor {
  param([int]$ToX, [int]$ToY)
  [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($ToX, $ToY)
}

switch ($Action) {
  'foreground' {
    $h = [TkInput.Native]::GetForegroundWindow()
    $procId = 0
    [void][TkInput.Native]::GetWindowThreadProcessId($h, [ref]$procId)
    try { (Get-Process -Id $procId).ProcessName } catch { 'unknown' }
  }
  'cursor' { Get-CursorText }
  'move' {
    Move-Cursor -ToX $X -ToY $Y
    Start-Sleep -Milliseconds 30
    Get-CursorText
  }
  'click' {
    Move-Cursor -ToX $X -ToY $Y
    Start-Sleep -Milliseconds 80
    [TkInput.Native]::mouse_event(0x0002, 0, 0, 0, [System.UIntPtr]::Zero) # LEFTDOWN
    Start-Sleep -Milliseconds 50
    [TkInput.Native]::mouse_event(0x0004, 0, 0, 0, [System.UIntPtr]::Zero) # LEFTUP
    'clicked'
  }
  'wheel' {
    Move-Cursor -ToX $X -ToY $Y
    Start-Sleep -Milliseconds 80
    # dwData is a DWORD: convert negative deltas to unsigned
    $dw = [int64]$Delta
    if ($dw -lt 0) { $dw = $dw + 4294967296 }
    [TkInput.Native]::mouse_event(0x0800, 0, 0, [uint32]$dw, [System.UIntPtr]::Zero) # MOUSEEVENTF_WHEEL
    Start-Sleep -Milliseconds 60
    "wheel $Delta"
  }
  default { throw "unknown action: $Action" }
}
