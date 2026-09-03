# Android app hosting / no-provider-API automation research

Verified 2026-09-03 against Android documentation and current source repositories.

## Verdict

**A personal sideloaded Android AI Broadcaster is feasible without provider APIs.** There is now a concrete open-source implementation of the hard part: [ClosePaw](https://github.com/imoonkey/closepaw) creates a secondary Android display through Shizuku, launches an arbitrary installed app on it, renders that display into its own `SurfaceView`, forwards touch/input, inspects its accessibility tree, and captures screenshots. Its [virtual-display implementation](https://github.com/imoonkey/closepaw/blob/main/doc/main/infra/virtual_display.md) is Apache-2.0 and has a signed [v0.1.0 APK release](https://github.com/imoonkey/closepaw/releases/tag/v0.1.0).

[Dextop](https://github.com/NarYuki/Dextop) independently proves the multi-app workspace half: its current Android app creates phone-only virtual displays, launches real installed apps, routes touch/keyboard input, and saves two-, three-, and four-pane workspaces. Its compatibility table calls Samsung One UI 8+ fully supported, and its signed [v1.6.3 APK](https://github.com/NarYuki/Dextop/releases/tag/v1.6.3) was released 2026-09-03. Dextop is GPL-3.0; use it as a proof/reference or accept GPL terms if copying its code.

This is the closest working answer to “put another app inside my app.” Technically the other app remains a separate Android task on a virtual display; AI Broadcaster displays and controls that task's rendered surface. It is not ordinary Android child-view embedding.

**Do not promise “perfect.”** It requires Shizuku + Accessibility, uses hidden Android services, needs validation on the exact Galaxy/One UI version, and can only read what the provider exposes to accessibility or screenshots. For AI Broadcaster's 17 current providers, real Chrome tabs controlled through CDP should be the primary path; native provider apps should be an optional path.

## Best concrete design

1. Build a private Kotlin APK. Sideload it; no store publication needed.
2. Reuse/adapt ClosePaw's [virtual-display package](https://github.com/imoonkey/closepaw/tree/main/app/src/main/kotlin/ai/closepaw/platform/virtualdisplay) and live viewer. It uses:
   - Shizuku to call `IDisplayManager`, `IInputManager`, and `IActivityTaskManager` with shell identity.
   - `ImageReader` while headless and a viewer `SurfaceView` for live in-app display.
   - accessibility windows filtered by display ID.
   - targeted input; fallback shell commands use `input -d <displayId>`.
3. Require one-time user setup: Developer options, wireless debugging, Shizuku authorization, Accessibility service, overlay permission, and battery-optimization exemption. Shizuku works without root on Android 11+ through wireless debugging, but generally must be restarted after reboot; see the [official setup guide](https://shizuku.rikka.app/guide/setup/) and [Shizuku API guide](https://github.com/RikkaApps/Shizuku-API). Shizuku v13.6.0 explicitly supports Android 16 QPR1 and adds an Android 13+ trusted-WLAN auto-start option in its [release notes](https://github.com/RikkaApps/Shizuku/releases/tag/v13.6.0).
4. Primary provider adapter: use the existing signed-in Chrome app, one tab per provider, and control each tab through Chrome DevTools Protocol. ClosePaw already implements [Shizuku-mediated JavaScript automation against real Chrome](https://github.com/imoonkey/closepaw/blob/main/doc/main/infra/browser.md). Chrome officially exposes each Android tab as a CDP target through `localabstract:chrome_devtools_remote`; see [Chrome's Android remote-debugging guide](https://developer.chrome.com/docs/devtools/remote-debugging/). This preserves real Chrome cookies/logins and gives exact DOM text. CDP is a browser debugging interface, not a provider API.
5. Port AI Broadcaster's provider selectors, prompt policy, delivery evidence, and timeouts to CDP scripts. Render collected responses as native cards in AI Broadcaster. No iframe/header bypass is then needed.
6. Optional native-app adapter: launch Gemini/other installed AI apps onto one or more virtual displays; enter/click/read through Accessibility. Show the selected display as an in-app panel. Prefer one display at first; many simultaneous app displays will consume substantial RAM/GPU and most of the current 17 providers have no native app.
7. Response extraction order: CDP DOM text > `AccessibilityNodeInfo` text > explicit provider Copy action > screenshot OCR. OCR should be a fallback because it loses formatting and can misread content.

This architecture can keep the provider's normal free website/app account. It does not use model/provider APIs.

### Active implementation references

| Project | Verified activity | What is reusable |
|---|---|---|
| [ClosePaw](https://github.com/imoonkey/closepaw) | Apache-2.0; APK v0.1.0 released 2026-05-28; source updated after release | Only found project implementing the complete Shizuku virtual-display + in-app live `SurfaceView` + all-display Accessibility path, plus real-Chrome CDP. Best base. |
| [Dextop](https://github.com/NarYuki/Dextop) | GPL-3.0; APK v1.6.3 released 2026-09-03; Samsung One UI 8+ documented as fully supported | Working phone-only virtual desktop with real installed apps, direct input, saved workspaces, and two-/three-/four-pane layouts. Best multi-app UX proof. |
| [droid-mcp](https://github.com/stixez/droid-mcp) | Apache-2.0; [v0.10.1](https://github.com/stixez/droid-mcp/releases/tag/v0.10.1) released 2026-07-19 | Android library modules for screen query, node lookup/click/text, IME input, overlays, screenshots, and Shizuku. Can be called directly from Kotlin without running MCP. Does not visually host another app. |
| [Mobilerun Portal](https://github.com/droidrun/mobilerun-portal) | v0.7.25 released 2026-08-18; Android build workflow passed | Mature proof of Accessibility tree, screenshots, gestures, app launching, and overlay exposed through local HTTP/WebSocket. Designed for an external controller, not in-app hosting. |
| [Autofish](https://github.com/felinics/Autofish) | Apache-2.0; source updated 2026-08-29; CLI v0.5.1 released 2026-05-28 | Deterministic observe/action/verify loop with Accessibility fallback and optional Shizuku. Useful control/recovery reference; also expects an external CLI. |

## What each Android mechanism can actually do

| Mechanism | Arbitrary installed app visible inside broadcaster? | Control/read output? | Requirement | Verdict |
|---|---|---|---|---|
| Cross-app Activity Embedding | Only if the target app opts in | Host can present opted-in activity; normal app isolation remains | Android 13+; target manifest trusts host certificate or sets `allowUntrustedActivityEmbedding=true` | Not useful for arbitrary AI apps. Default is false; a non-opted-in activity takes the full task. [Android docs](https://developer.android.com/develop/ui/views/layout/activity-embedding#cross_application_embedding) |
| `ActivityView` / `TaskView` | Technically yes | Full task surface/input | Platform/launcher privileges | Not available to a normal sideloaded APK. `ActivityView` is hidden/TestApi; `TaskOrganizer` is hidden and requires `MANAGE_ACTIVITY_TASKS`. AOSP defines that permission as `signature|recents`. [ActivityView source](https://android.googlesource.com/platform/frameworks/base/+/771f5faab6ae0721d26c2aeaf39d8a0f7bd4be11/core/java/android/app/ActivityView.java), [TaskOrganizer source](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/core/java/android/window/TaskOrganizer.java), [permission definition](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/android16-qpr2-release/core/res/AndroidManifest.xml) |
| Shizuku virtual display + `SurfaceView` | **Yes, as a streamed secondary-display task** | **Yes:** Accessibility tree, node actions, display-targeted input, screenshots | Shizuku shell identity + Accessibility; no root | Best working personal solution. Proven in ClosePaw source/release. |
| AccessibilityService on foreground app | No; broadcaster uses overlay while provider is foreground | Yes when nodes/actions are exposed; coordinates/gestures otherwise | User manually enables service | Best stock fallback. Android documents cross-app node inspection/actions and all-display windows. [Service guide](https://developer.android.com/guide/topics/ui/accessibility/service), [`getWindowsOnAllDisplays`](https://developer.android.com/reference/android/accessibilityservice/AccessibilityService#getWindowsOnAllDisplays()), [`ACTION_SET_TEXT`](https://developer.android.com/reference/android/view/accessibility/AccessibilityNodeInfo.AccessibilityAction#ACTION_SET_TEXT) |
| Shizuku alone | No public embedding primitive | Can launch apps, run shell input, inspect top task, and help create/control a virtual display | Wireless debugging or root; reactivation after reboot | Enabler, not the full UI automation layer. [Shizuku](https://github.com/RikkaApps/Shizuku) |
| UI Automator | No | Strong cross-app test control and inspection | Instrumentation/test runner, normally started by Android Studio/ADB | Good for automated testing, poor embedded runtime. It is explicitly an instrumentation framework. [Android docs](https://developer.android.com/training/testing/other-components/ui-automator) |
| Intents / shares | No | Can launch or send a prompt only when the target exposes an intent; result only when target implements it | None beyond package visibility | Useful shortcut, not generic automation or response retrieval. [Android docs](https://developer.android.com/training/basics/intents) |
| WebView | Embeds websites, not installed apps | JavaScript/DOM control possible | Separate WebView login/session | Possible, but less reliable login compatibility and does not share Chrome data. Android explicitly says browser data is not shared with the app. Never expose `addJavascriptInterface` to untrusted provider pages. [Android docs](https://developer.android.com/develop/ui/views/layout/webapps/webview) |
| Real Chrome + CDP over Shizuku | Chrome itself is separate; broadcaster renders its own response UI | **Exact tab DOM control/readback** | Shizuku and Chrome remote-debug socket | Best fit for the current website-heavy broadcaster. ClosePaw is working reference; Chrome documents the socket/targets. |
| Mobile browser extension | Browser-dependent, not an app-hosting solution | Potentially close to desktop extension | Signing/store or experimental browser-specific install | Secondary option only. Firefox Android supports compatible signed add-ons, while standard Firefox blocks unsigned ones. Edge's official developer-mode policy says Android is unsupported. [Firefox Android](https://support.mozilla.org/en-US/kb/find-and-install-add-ons-firefox-android), [Firefox signing](https://support.mozilla.org/en-US/kb/add-on-signing-in-firefox), [Edge policy](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/extensiondevelopermodesettings) |

Android's public virtual-display API renders to an app-provided `Surface`, and public displays allow apps to open windows. Secondary-display activity launches are official, but permissions and display ownership constrain them. [DisplayManager](https://developer.android.com/reference/android/hardware/display/DisplayManager#createVirtualDisplay(java.lang.String,int,int,int,android.view.Surface,int)), [ActivityOptions](https://developer.android.com/reference/android/app/ActivityOptions#setLaunchDisplayId(int)), [multi-display overview](https://source.android.com/docs/core/display/multi_display). ClosePaw bridges the remaining privileged calls with Shizuku instead of requiring a system-signed broadcaster.

Samsung is a favorable target because DeX is built on Android multi-window/multi-display and Samsung documents simultaneous apps and secondary-display contexts. That supports feasibility, not compatibility proof for every Galaxy/One UI release. [Samsung DeX docs](https://developer.samsung.com/samsung-dex/how-it-works.html), [Samsung optimization guide](https://developer.samsung.com/samsung-dex/modify-optimizing.html).

### Exact connected-device check

Read-only ADB inspection on 2026-09-03 identified the user's connected phone as `SM-S916W`, Android 16 / API 36, One UI 8.0. The device reports both `android.software.activities_on_secondary_displays` and `android.software.freeform_window_management`. ChatGPT, Gemini, Claude, DeepSeek, Grok, and Perplexity are already installed. This clears the device-level prerequisites; it does not replace an end-to-end app test. Shizuku was not installed.

## App-container projects

| Project | Verified state | Root/Shizuku | License | Use? |
|---|---|---|---|---|
| [VirtualApp](https://github.com/asLody/VirtualApp) | README says public code stopped in Dec 2017; current Android support is commercial-only | No root claimed | No normal OSS license surfaced; README requires purchasing commercial authorization even for internal use | **No.** Old public engine and licensing risk. |
| [FBlackBox/BlackBox](https://github.com/FBlackBox/BlackBox) | Maintainer deleted the code and dissolved the project; repo now contains only metadata/README | Historically no root | No license surfaced | **No.** Nothing viable to integrate. |
| [Twoyi](https://github.com/twoyi/twoyi) | Archived/discontinued 2023; supports hosts Android 8.1–12; guest is Android 8.1; ROM source was incomplete | No root claimed | MPL-2.0 | **No** for a current Galaxy. |
| [VineOS](https://github.com/Hexadecinull/VineOS) | Active in 2026 but still “Phase 1”; first ROM and display/input are roadmap items; no-root path is Phase 4 | Current runtime requires `CAP_SYS_ADMIN`; no-root planned | GPL-3.0 | **Not yet.** Research project, no usable release. |
| [ShadowCore](https://github.com/ReturnKartikey/ShadowCore) | Very young 2026 wrapper claiming BlackBox integration; minimal adoption and no independent AI-app compatibility evidence | Shizuku | README says Apache-2.0; GitHub did not detect a license file during review | **Do not base the broadcaster on it.** |

Containers are also the wrong layer: cloned apps get a separate guest data/login environment, and modern GMS/Play Integrity, split APKs, native code, or anti-tamper checks may fail. A virtual **display** runs the real installed app with its existing login instead.

## Exact limitations

- No cross-app route can guarantee every provider version forever. Provider UIs/selectors change.
- Accessibility only receives semantics the provider publishes. Custom canvas/poorly annotated UI can hide text or actions; Android's own Compose guide explains that low-level custom UI exposes nothing useful unless semantics are added. [Compose semantics](https://developer.android.com/develop/ui/compose/accessibility/semantics)
- `FLAG_SECURE` content is blank on a non-secure virtual display and accessibility screenshot APIs can return `ERROR_TAKE_SCREENSHOT_SECURE_WINDOW`. [Virtual-display security](https://developer.android.com/reference/android/hardware/display/DisplayManager#VIRTUAL_DISPLAY_FLAG_SECURE), [AccessibilityService errors](https://developer.android.com/reference/android/accessibilityservice/AccessibilityService#ERROR_TAKE_SCREENSHOT_SECURE_WINDOW)
- An app may refuse secondary displays, require a fixed orientation, open a sub-activity on the default display, or use a launch mode that moves its task. Test every target package/version.
- Shizuku is powerful shell access. Limit commands, keep everything local, and never expose an unauthenticated control server.
- Samsung battery management may stop the broadcaster/Shizuku unless excluded from optimization.
- One virtual display per provider is possible in principle but not sensible for 17 providers. Use Chrome tabs + CDP for fan-out; reserve app displays for a few app-only targets.
- Attachments are harder than text. Web tabs can use DOM/file-input paths; native apps may require `ACTION_SEND`, a file picker, or fragile accessibility steps. Verify upload completion before submit.
- Website/account terms, CAPTCHA, rate limits, and anti-bot checks still apply.

## Fast proof before a full port

1. On the exact Samsung, verify secondary-display support: `adb shell pm list features | findstr activities_on_secondary_displays`.
2. Install ClosePaw's release APK and Shizuku; enable Accessibility; prove its virtual-display viewer with Settings, Chrome, then one installed AI app.
3. Prove on-device Chrome CDP control against Gemini, Copilot, and one difficult Tier-C provider while signed in. Validate prompt insertion, one-submit behavior, delivery evidence, exact response extraction, logout/CAPTCHA handling, and one image/PDF.
4. If those pass, port a three-provider Android proof-of-concept. Expand only after testing the real provider matrix.

**Recommendation:** fork/adapt ClosePaw's Shizuku virtual-display and Chrome-CDP work under Apache-2.0, keep AI Broadcaster's deterministic provider adapters, and build a private Android dashboard. This is genuinely workable; “perfect on every app/provider” is not technically guaranteeable.
