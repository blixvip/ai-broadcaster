#Requires AutoHotkey v2.0
#SingleInstance Force
;==============================================================================
;  Screenshot -> AI Broadcaster
;------------------------------------------------------------------------------
;  Press  Ctrl+Alt+Shift+V  and it will:
;    1. Capture the monitor your MOUSE is on, straight to the clipboard.
;    2. Focus Chrome.
;    3. Fire AI Broadcaster's "grab to composer" command (Alt+Shift+V).
;  The screenshot appears in the composer as an attached image. Type your
;  question next to it and hit SEND to broadcast.
;
;  NOTE: You only press Ctrl+Alt+Shift+V. It internally presses Alt+Shift+V for
;  you because Chrome won't let an extension bind a Ctrl+Alt+... shortcut.
;
;  ---- TWEAK ME ----
;  * Change the hotkey: edit the line   ^!+v::   below (^=Ctrl !=Alt +=Shift #=Win).
;  * Auto-broadcast instead of just filling the box:
;       set GRAB := "!+g"   (Alt+Shift+G = grab AND send immediately)
;==============================================================================

GRAB := "!+v"          ; Alt+Shift+V = drop into composer, you hit SEND. "!+g" = grab + auto-broadcast.
CHROME := "ahk_exe chrome.exe"

^!+v:: ShotToBroadcaster()          ; Ctrl+Alt+Shift+V

ShotToBroadcaster() {
    global GRAB, CHROME
    if !CaptureActiveMonitorToClipboard() {
        Flash("Screenshot failed")
        return
    }
    if !WinExist(CHROME) {
        Flash("Chrome isn't running")
        return
    }
    WinActivate CHROME
    if !WinWaitActive(CHROME, , 1) {
        Flash("Couldn't focus Chrome")
        return
    }
    Sleep 130                 ; let the window settle so the command dispatches
    ; Drop the trigger's held modifiers so Chrome sees a clean Alt+Shift+V,
    ; not Ctrl+Alt+Shift+V (which wouldn't match the extension command).
    Send "{Ctrl up}{Alt up}{Shift up}"
    Sleep 25
    Send GRAB
    Flash("Screenshot -> AI Broadcaster")
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
