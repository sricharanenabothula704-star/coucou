// Talking to the chat: the microphone records only between a click on the mic
// and the next click (2 minutes at most), then Gemini — with the user's own
// Google AI key, the one the chat uses — writes down what was said, and the
// chat sends it. Nothing is recorded otherwise, and the audio is never kept.
//
// Recording uses the plain Windows wave-in API (16 kHz, mono, 16-bit): no new
// crate. While it records, the loudness goes to the page ("voice-level") so
// the mic button can move with the voice.

use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

const RATE: u32 = 16_000;
const MAX_SECS: usize = 120;
const LEVEL_EVENT: &str = "voice-level";

static RECORDING: AtomicBool = AtomicBool::new(false);
static STOP: AtomicBool = AtomicBool::new(false);
static RESULT: Mutex<Option<std::sync::mpsc::Receiver<Vec<i16>>>> = Mutex::new(None);

/// A WAV file around 16-bit mono samples.
pub fn wav(samples: &[i16], rate: u32) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

/// 0…1 loudness of a buffer, for the mic animation.
pub fn level(samples: &[i16]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum: f64 = samples.iter().map(|&s| (s as f64) * (s as f64)).sum();
    let rms = (sum / samples.len() as f64).sqrt() / 32768.0;
    ((rms * 6.0).min(1.0)) as f32
}

/// Sounds like nobody spoke: too short or too quiet to send.
pub fn silent(samples: &[i16]) -> bool {
    samples.len() < (RATE as usize) / 3 || level(samples) < 0.02
}

#[tauri::command]
pub fn voice_start(app: AppHandle) -> Result<(), String> {
    if RECORDING.swap(true, Ordering::AcqRel) {
        return Err("already recording".into());
    }
    STOP.store(false, Ordering::Release);
    let (tx, rx) = std::sync::mpsc::channel();
    *RESULT.lock().unwrap_or_else(|e| e.into_inner()) = Some(rx);
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    let _ = std::thread::Builder::new().name("coucou-voice".into()).spawn(move || {
        let samples = imp::record(&app, &ready_tx);
        let _ = tx.send(samples);
        RECORDING.store(false, Ordering::Release);
    });
    match ready_rx.recv_timeout(std::time::Duration::from_secs(3)) {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => Err(e),
        Err(_) => Err("The microphone didn't answer.".into()),
    }
}

/// Stops recording; with `transcribe`, returns what was said.
#[tauri::command]
pub async fn voice_stop(shared: State<'_, crate::Shared>, transcribe: bool) -> Result<String, String> {
    STOP.store(true, Ordering::Release);
    let rx = RESULT.lock().unwrap_or_else(|e| e.into_inner()).take();
    let Some(rx) = rx else { return Err("not recording".into()) };
    let samples = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap_or_default())
        .await
        .map_err(|e| e.to_string())?;
    if !transcribe {
        return Ok(String::new());
    }
    if silent(&samples) {
        return Err("I didn't hear anything.".into());
    }
    let model = {
        let s = shared.settings.lock().unwrap_or_else(|e| e.into_inner());
        s.chat_models.get("google").cloned().unwrap_or_default()
    };
    transcribe_wav(&wav(&samples, RATE), &model).await
}

async fn transcribe_wav(audio: &[u8], chosen: &str) -> Result<String, String> {
    let key = crate::secrets::get("google-api-key")
        .ok_or_else(|| "Add your Google AI key in Settings → Chat to talk to Coucou.".to_string())?;
    let body = json!({
        "contents": [{ "parts": [
            { "text": "Transcribe this recording exactly as spoken, in the language spoken. Reply with the transcript only — no quotes, no notes. If nothing is said, reply with nothing." },
            { "inline_data": { "mime_type": "audio/wav", "data": crate::claude::base64_for(audio) } }
        ]}],
        "generationConfig": { "temperature": 0 }
    });
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    let mut models: Vec<&str> = Vec::new();
    if chosen.starts_with("gemini") {
        models.push(chosen);
    }
    models.extend(["gemini-2.5-flash", "gemini-flash-latest"]);
    let mut last = String::new();
    for model in models {
        let url = format!("https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent");
        let resp = client.post(&url).header("x-goog-api-key", &key).json(&body).send().await.map_err(|e| e.to_string())?;
        let status = resp.status();
        let value: serde_json::Value = resp.json().await.unwrap_or_default();
        if status.is_success() {
            let text = value["candidates"][0]["content"]["parts"]
                .as_array()
                .map(|parts| parts.iter().filter_map(|p| p["text"].as_str()).collect::<String>())
                .unwrap_or_default();
            return Ok(text.trim().to_string());
        }
        last = format!(
            "Google AI {}: {}",
            status.as_u16(),
            value["error"]["message"].as_str().unwrap_or("no details")
        );
        // A model this key can't use: try the next; anything else is the answer.
        if status.as_u16() != 404 && status.as_u16() != 400 {
            break;
        }
    }
    Err(last)
}

#[cfg(windows)]
mod imp {
    use super::*;
    use windows::core::PSTR;
    use windows::Win32::Media::Audio::*;

    const BUFFERS: usize = 6;
    const BUFFER_SAMPLES: usize = (RATE as usize) / 5; // 200 ms

    pub fn record(app: &AppHandle, ready: &std::sync::mpsc::Sender<Result<(), String>>) -> Vec<i16> {
        let format = WAVEFORMATEX {
            wFormatTag: WAVE_FORMAT_PCM as u16,
            nChannels: 1,
            nSamplesPerSec: RATE,
            nAvgBytesPerSec: RATE * 2,
            nBlockAlign: 2,
            wBitsPerSample: 16,
            cbSize: 0,
        };
        let mut handle = HWAVEIN::default();
        let opened = unsafe { waveInOpen(Some(&mut handle), WAVE_MAPPER, &format, None, None, CALLBACK_NULL) };
        if opened != 0 {
            let _ = ready.send(Err("No microphone, or Windows doesn't let apps use it (Settings → Privacy → Microphone).".into()));
            return Vec::new();
        }
        let mut data: Vec<Vec<i16>> = (0..BUFFERS).map(|_| vec![0i16; BUFFER_SAMPLES]).collect();
        let mut headers: Vec<WAVEHDR> = Vec::with_capacity(BUFFERS);
        for buf in data.iter_mut() {
            headers.push(WAVEHDR {
                lpData: PSTR(buf.as_mut_ptr() as *mut u8),
                dwBufferLength: (BUFFER_SAMPLES * 2) as u32,
                ..Default::default()
            });
        }
        let size = std::mem::size_of::<WAVEHDR>() as u32;
        unsafe {
            for h in headers.iter_mut() {
                waveInPrepareHeader(handle, h, size);
                waveInAddBuffer(handle, h, size);
            }
            waveInStart(handle);
        }
        let _ = ready.send(Ok(()));

        let mut samples: Vec<i16> = Vec::new();
        let cap = RATE as usize * MAX_SECS;
        loop {
            let stopping = STOP.load(Ordering::Acquire) || samples.len() >= cap;
            if stopping {
                unsafe {
                    waveInStop(handle);
                    waveInReset(handle);
                }
            }
            for (i, h) in headers.iter_mut().enumerate() {
                if h.dwFlags & WHDR_DONE != 0 {
                    let n = (h.dwBytesRecorded as usize / 2).min(BUFFER_SAMPLES);
                    let chunk = &data[i][..n];
                    if n > 0 {
                        let _ = app.emit(LEVEL_EVENT, level(chunk));
                        samples.extend_from_slice(chunk);
                    }
                    h.dwFlags &= !WHDR_DONE;
                    h.dwBytesRecorded = 0;
                    if !stopping {
                        unsafe { waveInAddBuffer(handle, h, size) };
                    }
                }
            }
            if stopping {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(40));
        }
        unsafe {
            for h in headers.iter_mut() {
                waveInUnprepareHeader(handle, h, size);
            }
            waveInClose(handle);
        }
        let _ = app.emit(LEVEL_EVENT, 0.0f32);
        samples.truncate(cap);
        samples
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;
    pub fn record(_app: &AppHandle, ready: &std::sync::mpsc::Sender<Result<(), String>>) -> Vec<i16> {
        let _ = ready.send(Err("The microphone is Windows-only for now.".into()));
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_wav_header_around_the_samples() {
        let w = wav(&[0, 1000, -1000], 16_000);
        assert_eq!(&w[0..4], b"RIFF");
        assert_eq!(&w[8..16], b"WAVEfmt ");
        assert_eq!(u32::from_le_bytes(w[40..44].try_into().unwrap()), 6);
        assert_eq!(w.len(), 44 + 6);
    }

    #[test]
    fn silence_is_not_sent() {
        assert!(silent(&vec![0i16; 16_000]));
        assert!(silent(&[5000i16; 100]));
        let speech: Vec<i16> = (0..16_000).map(|i| if i % 2 == 0 { 6000 } else { -6000 }).collect();
        assert!(!silent(&speech));
        assert!(level(&speech) > 0.5);
    }
}
