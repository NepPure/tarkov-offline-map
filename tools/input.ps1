param(
  [Parameter(Mandatory = $true)][string]$Action,
  [int]$X = 0,
  [int]$Y = 0
)
# 真实鼠标输入工具（验收用）：SetCursorPos / mouse_event 属于系统级输入，不是合成事件。
# 用法:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/input.ps1 foreground
#   powershell ... -File tools/input.ps1 cursor
#   powershell ... -File tools/input.ps1 move -X 100 -Y 200
#   powershell ... -File tools/input.ps1 click -X 100 -Y 200
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

switch ($Action) {
  'foreground' {
    $h = [TkInput.Native]::GetForegroundWindow()
    $procId = 0
    [void][TkInput.Native]::GetWindowThreadProcessId($h, [ref]$procId)
    try { (Get-Process -Id $procId).ProcessName } catch { 'unknown' }
  }
  'cursor' { Get-CursorText }
  'move' {
    [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($X, $Y)
    Start-Sleep -Milliseconds 30
    Get-CursorText
  }
  'click' {
    [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($X, $Y)
    Start-Sleep -Milliseconds 80
    [TkInput.Native]::mouse_event(0x0002, 0, 0, 0, [System.UIntPtr]::Zero) # LEFTDOWN
    Start-Sleep -Milliseconds 50
    [TkInput.Native]::mouse_event(0x0004, 0, 0, 0, [System.UIntPtr]::Zero) # LEFTUP
    'clicked'
  }
  default { throw "unknown action: $Action" }
}
