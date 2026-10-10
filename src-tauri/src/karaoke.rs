//! Live Karaoke Room — native glue.
//!
//! The room itself (signaling, sync, voice) lives in the webview and the Python sidecar. What
//! the core has to provide is the one thing a webview cannot grant itself: microphone access.
//!
//! * Windows (WebView2): `getUserMedia` raises a PermissionRequested event. Left unhandled,
//!   WebView2 shows its own browser-style prompt on every launch. We answer it for the
//!   microphone — and only the microphone, and only for Kodama's own pages.
//! * Linux (WebKitGTK): media capture and WebRTC are OFF by default and wry enables neither, so
//!   `navigator.mediaDevices` is missing entirely. We switch both on and answer the
//!   permission-request signal for audio-only user-media requests from Kodama's own pages.
//! * macOS (WKWebView): wry already answers the capture prompt; the OS asks the user once,
//!   using NSMicrophoneUsageDescription from Info.plist (see src-tauri/Info.plist).
//!
//! Plus one Windows-only nicety: while the voice chat is live, Kodama's own playback sessions
//! opt out of Windows "communications ducking". Opening a microphone otherwise makes Windows
//! lower "other sounds" by 80% by default — which here would be the karaoke track itself.

use tauri::{Runtime, WebviewWindow};

/// Origins whose pages may use the microphone without a prompt: the bundled app and the dev
/// server. Anything else (a page navigated to by accident, an iframe) still gets refused.
#[allow(dead_code)]
fn is_trusted_origin(uri: &str) -> bool {
    let u = uri.to_ascii_lowercase();
    u.starts_with("tauri://localhost")
        || u.starts_with("http://tauri.localhost")
        || u.starts_with("https://tauri.localhost")
        || u.starts_with("http://localhost:1421")
}

/// Call once per window that hosts the karaoke room (the main window).
pub fn enable_voice_capture<R: Runtime>(window: &WebviewWindow<R>) {
    let _ = window.with_webview(|wv| {
        #[cfg(target_os = "linux")]
        {
            use webkit2gtk::glib::prelude::*;
            use webkit2gtk::{
                PermissionRequestExt, SettingsExt, UserMediaPermissionRequest,
                UserMediaPermissionRequestExt, WebViewExt,
            };
            let view = wv.inner();
            if let Some(settings) = view.settings() {
                settings.set_enable_media_stream(true);
                settings.set_enable_webrtc(true);
                settings.set_enable_mediasource(true);
            }
            view.connect_permission_request(|view, request| {
                let Some(media) = request.downcast_ref::<UserMediaPermissionRequest>() else {
                    return false; // not ours to decide — fall through to WebKit's default
                };
                let trusted = view.uri().map(|u| is_trusted_origin(&u)).unwrap_or(false);
                if trusted && media.is_for_audio_device() && !media.is_for_video_device() {
                    request.allow();
                } else {
                    request.deny();
                }
                true
            });
        }

        #[cfg(windows)]
        unsafe {
            use webview2_com::Microsoft::Web::WebView2::Win32::{
                COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
                COREWEBVIEW2_PERMISSION_STATE_ALLOW,
            };
            use webview2_com::PermissionRequestedEventHandler;

            let Ok(core) = wv.controller().CoreWebView2() else { return };
            let mut token: i64 = 0;
            let _ = core.add_PermissionRequested(
                &PermissionRequestedEventHandler::create(Box::new(|_, args| {
                    let Some(args) = args else { return Ok(()) };
                    let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                    args.PermissionKind(&mut kind)?;
                    if kind != COREWEBVIEW2_PERMISSION_KIND_MICROPHONE {
                        return Ok(()); // leave every other permission to WebView2 / wry
                    }
                    let mut uri = windows_core::PWSTR::null();
                    args.Uri(&mut uri)?;
                    let uri = webview2_com::take_pwstr(uri);
                    if is_trusted_origin(&uri) {
                        args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                    }
                    Ok(())
                })),
                &mut token,
            );
        }

        #[cfg(target_os = "macos")]
        {
            let _ = wv; // handled by wry + Info.plist
        }
    });
}

// ── Windows communications ducking ──────────────────────────────────────────────────────────

#[cfg(windows)]
mod ducking {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Once;

    pub static ACTIVE: AtomicBool = AtomicBool::new(false);
    static START: Once = Once::new();

    /// Set the ducking preference on every audio session that belongs to this process (rodio's
    /// output) on every active render endpoint — the user may have picked a non-default output.
    fn apply(opt_out: bool) {
        use windows::{core::*, Win32::Media::Audio::*, Win32::System::Com::*};
        let me = std::process::id();
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let Ok(enumerator) =
                CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL)
            else {
                return;
            };
            let Ok(devices) = enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE) else {
                return;
            };
            let n = devices.GetCount().unwrap_or(0);
            for d in 0..n {
                let Ok(device) = devices.Item(d) else { continue };
                let Ok(manager) = device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else {
                    continue;
                };
                let Ok(sessions) = manager.GetSessionEnumerator() else { continue };
                let count = sessions.GetCount().unwrap_or(0);
                for i in 0..count {
                    let Ok(ctrl) = sessions.GetSession(i) else { continue };
                    let Ok(ctrl2) = ctrl.cast::<IAudioSessionControl2>() else { continue };
                    if ctrl2.GetProcessId().ok() == Some(me) {
                        let _ = ctrl2.SetDuckingPreference(opt_out);
                    }
                }
            }
        }
    }

    pub fn set_active(active: bool) {
        let was = ACTIVE.swap(active, Ordering::SeqCst);
        if was && !active {
            std::thread::spawn(|| apply(false));
        }
        if active {
            // Sessions come and go with tracks (rodio reopens its stream on output changes),
            // so a one-shot call would miss the next one. Re-apply every few seconds while live.
            START.call_once(|| {
                std::thread::spawn(|| loop {
                    if ACTIVE.load(Ordering::SeqCst) {
                        apply(true);
                    }
                    std::thread::sleep(std::time::Duration::from_secs(3));
                });
            });
            std::thread::spawn(|| apply(true));
        }
    }
}

/// The frontend calls this when the karaoke microphone goes live / is released.
#[tauri::command]
pub fn karaoke_voice_active(active: bool) {
    #[cfg(windows)]
    ducking::set_active(active);
    #[cfg(not(windows))]
    let _ = active;
}
