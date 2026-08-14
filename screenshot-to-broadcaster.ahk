#Requires AutoHotkey v2.0
#SingleInstance Force
;==============================================================================
;  Screenshot -> AI Broadcaster
;------------------------------------------------------------------------------
;  Press  Ctrl+Alt+Shift+V  and it will:
;    1. Capture the monitor your MOUSE is on, straight to the clipboard.
;  The screenshot stays on the clipboard. Paste it into AI Broadcaster when
;  ready. This helper never activates, resizes, or sends keys to Chrome.
;
;  Change the hotkey by editing ^!+v:: below (^=Ctrl !=Alt +=Shift #=Win).
;==============================================================================

^!+v:: ShotToBroadcaster()          ; Ctrl+Alt+Shift+V

ShotToBroadcaster() {
    if !CaptureActiveMonitorToClipboard() {
        Flash("Screenshot failed")
        return
    }
    Flash("Screenshot copied - paste in AI Broadcaster")
}

; Capture the monitor under the mouse to the clipboard as an image that Chrome
; can paste. Uses .NET (SetDataObject ...,$true) so the image survives after the
; helper process exits. Runs hidden -> no visible console flash.
CaptureActiveMonitorToClipboard() {
    ps := "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; "
        . "$pt=[System.Windows.Forms.Cursor]::Position; "
        . "$s=[System.Windows.Forms.Screen]::FromPoint($pt).Bounds; "
        . "$bmp=New-Object System.Drawing.Bitmap($s.Width,$s.Height); "
        . "$g=[System.Drawing.Graphics]::FromImage($bmp); "
        . "$g.CopyFromScreen($s.Location,[System.Drawing.Point]::Empty,$s.Size); "
        . "$do=New-Object System.Windows.Forms.DataObject; $do.SetImage($bmp); "
        . "[System.Windows.Forms.Clipboard]::SetDataObject($do,$true); "
        . "$g.Dispose(); $bmp.Dispose()"
    try {
        exit := RunWait('powershell.exe -NoProfile -STA -WindowStyle Hidden -Command "' ps '"', , "Hide")
        return exit = 0
    } catch {
        return false
    }
}

Flash(msg) {
    ToolTip msg
    SetTimer () => ToolTip(), -1000
}
