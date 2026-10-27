import React, { useState, useEffect, useRef } from 'react';

/* =====================================================================
   VibeTune Pro — Studio Tuner
   - Micrófono real (getUserMedia) + detección de tono YIN
   - Misma funcionalidad en móvil y desktop (un solo árbol de componentes)
   - Formato de notas: 'full' => "E2 (Mi)"  |  'letter' => "E"
   - Afinaciones personalizadas guardadas en localStorage (+ exportar/importar)
   ===================================================================== */

/* ------------------------- Utilidades musicales ------------------------- */
const SEMITONES = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };
const NOTE_NAMES = Object.keys(SEMITONES);
const SOLF = { C: 'Do', D: 'Re', E: 'Mi', F: 'Fa', G: 'Sol', A: 'La', B: 'Si' };
const OCTAVES = [1, 2, 3, 4, 5, 6];

const parseNote = (n) => {
  const m = /^([A-G][#b]?)(-?\d)$/.exec(n || '');
  return m ? { name: m[1], oct: parseInt(m[2], 10) } : { name: 'E', oct: 2 };
};
const noteToHz = (n) => {
  const { name, oct } = parseNote(n);
  const midi = (oct + 1) * 12 + SEMITONES[name];
  return Math.round(440 * Math.pow(2, (midi - 69) / 12) * 100) / 100;
};
const letterOf = (n) => parseNote(n).name; // "E2" -> "E", "F#3" -> "F#"
const solfOf = (n) => {
  const name = parseNote(n).name;
  return SOLF[name[0]] + name.slice(1); // "F#3" -> "Fa#"
};
// Texto según el formato elegido
const labelOf = (n, fmt) => (fmt === 'letter' ? letterOf(n) : `${n} (${solfOf(n)})`);

const makeStrings = (notes) => notes.map((note, i) => ({ str: 6 - i, note, hz: noteToHz(note) }));

const PRESETS = [
  { id: 'standard', name: 'Estándar (E Standard)', short: 'Estándar E', tag: 'Por defecto', desc: 'Guitarra Acústica & Eléctrica', notes: ['E2', 'A2', 'D3', 'G3', 'B3', 'E4'] },
  { id: 'dropd', name: 'Drop D (D A D G B E)', short: 'Drop D', tag: 'Rock / Metal', desc: 'Sexta cuerda afinada un tono abajo (Re)', notes: ['D2', 'A2', 'D3', 'G3', 'B3', 'E4'] },
  { id: 'opend', name: 'Open D (D A D F# A D)', short: 'Open D', tag: 'Slide / Folk', desc: 'Acorde mayor al aire, ideal para slide guitar', notes: ['D2', 'A2', 'D3', 'F#3', 'A3', 'D4'] },
  { id: 'halfstep', name: 'Medio Tono Abajo (Eb Standard)', short: 'Medio Tono Abajo', tag: 'Blues / Grunge', desc: 'Tensión menor, sonido más cálido (Hendrix, SRV)', notes: ['Eb2', 'Ab2', 'Db3', 'Gb3', 'Bb3', 'Eb4'] },
].map((p) => ({ ...p, strings: makeStrings(p.notes) }));

/* ----------------------------- Almacenamiento ----------------------------- */
const PREFS_KEY = 'vibetune_prefs_v2';
const CUSTOM_KEY = 'vibetune_custom_tunings_v2';
const HIST_KEY = 'vibetune_history_v2';

const load = (k, fallback) => {
  try {
    const v = localStorage.getItem(k);
    return v ? JSON.parse(v) : fallback;
  } catch (e) {
    return fallback;
  }
};
const save = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
    return true;
  } catch (e) {
    return false;
  }
};

const DEFAULT_PREFS = {
  notation: 'full', // 'full' | 'letter'
  a4: 440,
  tolerance: 3,
  gate: -50, // dB
  chime: true,
  flash: true,
  mode: 'auto', // 'auto' | 'manual'
  tuningId: 'standard',
  favs: [],
};

/* ------------------------- Detección de tono (YIN) ------------------------- */
function yin(buf, sampleRate) {
  const W = Math.floor(buf.length / 2);
  const minTau = Math.floor(sampleRate / 1000); // hasta ~1000 Hz
  const maxTau = Math.min(W - 1, Math.floor(sampleRate / 50)); // desde ~50 Hz
  const d = new Float32Array(maxTau + 2);
  for (let tau = 1; tau <= maxTau + 1; tau++) {
    let sum = 0;
    for (let i = 0; i < W; i++) {
      const diff = buf[i] - buf[i + tau];
      sum += diff * diff;
    }
    d[tau] = sum;
  }
  // Diferencia normalizada (CMND)
  let running = 0;
  d[0] = 1;
  for (let tau = 1; tau <= maxTau + 1; tau++) {
    running += d[tau];
    d[tau] = running === 0 ? 1 : (d[tau] * tau) / running;
  }
  let tau = -1;
  for (let t = Math.max(2, minTau); t <= maxTau; t++) {
    if (d[t] < 0.12) {
      while (t + 1 <= maxTau && d[t + 1] < d[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau === -1) return null;
  // Interpolación parabólica
  const a = d[tau - 1], b = d[tau], c = d[tau + 1];
  const denom = 2 * (2 * b - c - a);
  const better = denom !== 0 ? tau + (c - a) / denom : tau;
  return { freq: sampleRate / better, prob: 1 - d[tau] };
}

const median = (arr) => {
  const s = [...arr].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

function useMediaQuery(q) {
  const [m, setM] = useState(() => (typeof window !== 'undefined' ? window.matchMedia(q).matches : false));
  useEffect(() => {
    const mq = window.matchMedia(q);
    const h = (e) => setM(e.matches);
    setM(mq.matches);
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, [q]);
  return m;
}

const Icon = ({ n, className = '' }) => <span className={`material-symbols-outlined ${className}`}>{n}</span>;

const TABS = [
  { id: 'tuner', label: 'Afinador', icon: 'graphic_eq' },
  { id: 'tunings', label: 'Afinaciones', icon: 'tune' },
  { id: 'history', label: 'Historial', icon: 'history' },
  { id: 'settings', label: 'Ajustes', icon: 'settings' },
];

const EMPTY_READING = { hz: 0, cents: 0, str: null, signal: false, conf: 0 };
const newDraft = (n) => ({ id: null, name: `Mi Afinación Custom #${n}`, strings: PRESETS[0].strings.map((s) => ({ ...s })) });

const card = 'bg-[#1c1b20]/90 border border-[#2b292f] rounded-2xl p-4 lg:p-5';
const btnGhost = 'bg-[#201f24] hover:bg-[#36343a] border border-[#4d4354] text-[#ddb7ff] font-bold text-xs rounded-xl';

/* ================================= APP ================================= */
export default function App() {
  const isDesktop = useMediaQuery('(min-width: 1024px)');

  const [prefs, setPrefs] = useState(() => ({ ...DEFAULT_PREFS, ...load(PREFS_KEY, {}) }));
  const setPref = (k, v) => setPrefs((p) => ({ ...p, [k]: v }));
  const [customs, setCustoms] = useState(() => {
    const c = load(CUSTOM_KEY, []);
    return Array.isArray(c) ? c : [];
  });
  const [history, setHistory] = useState(() => {
    const h = load(HIST_KEY, []);
    return Array.isArray(h) ? h : [];
  });

  const [tab, setTab] = useState('tuner');
  const [selected, setSelected] = useState(6);
  const [micState, setMicState] = useState('idle'); // idle | starting | on | error
  const [micError, setMicError] = useState('');
  const [reading, setReading] = useState(EMPTY_READING);
  const [level, setLevel] = useState(-100);
  const [bars, setBars] = useState(Array(16).fill(0));
  const [engineInfo, setEngineInfo] = useState({ sr: 0, latency: 0 });
  const [muted, setMuted] = useState(false);
  const [toast, setToast] = useState('');
  const [draft, setDraft] = useState(() => newDraft(1));

  const engineRef = useRef(null);
  const toneCtxRef = useRef(null);
  const editorRef = useRef(null);
  const fileRef = useRef(null);
  const toastTimer = useRef(null);

  const allTunings = [...PRESETS, ...customs].sort(
    (a, b) => (prefs.favs.includes(b.id) ? 1 : 0) - (prefs.favs.includes(a.id) ? 1 : 0)
  );
  const active = [...PRESETS, ...customs].find((t) => t.id === prefs.tuningId) || PRESETS[0];
  const strings = active.strings;

  // Configuración accesible desde el loop de audio sin reiniciarlo
  const cfgRef = useRef({});
  cfgRef.current = { strings, a4: prefs.a4, mode: prefs.mode, selected, gate: prefs.gate, tolerance: prefs.tolerance, chime: prefs.chime, muted, tuningName: active.short || active.name };

  const flash = (msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 2800);
  };

  /* ---------- Fuentes e iconos (se inyectan una sola vez) ---------- */
  useEffect(() => {
    const links = [
      'https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;800&family=Inter:wght@400;500;600;700&display=swap',
      'https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,400,0,0',
    ].map((href) => {
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = href;
      document.head.appendChild(l);
      return l;
    });
    const st = document.createElement('style');
    st.textContent = `.font-outfit{font-family:'Outfit',sans-serif}.material-symbols-outlined{font-size:20px;line-height:1;user-select:none}body{font-family:'Inter',system-ui,sans-serif;background:#141318}`;
    document.head.appendChild(st);
    return () => {
      links.forEach((l) => l.remove());
      st.remove();
    };
  }, []);

  /* ---------- Persistencia ---------- */
  useEffect(() => { save(PREFS_KEY, prefs); }, [prefs]);
  useEffect(() => { save(HIST_KEY, history); }, [history]);

  /* ---------- Audio de salida (tonos de referencia y chime) ---------- */
  const getToneCtx = () => {
    if (!toneCtxRef.current) toneCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
    if (toneCtxRef.current.state === 'suspended') toneCtxRef.current.resume();
    return toneCtxRef.current;
  };

  const playTone = (hz, harmonics = false) => {
    if (cfgRef.current.muted) return flash('Silencio activado');
    try {
      const ctx = getToneCtx();
      const now = ctx.currentTime;
      (harmonics ? [1, 2, 3] : [1]).forEach((mul, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = hz * mul;
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.18 / (i + 1), now + 0.05);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.6);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 1.7);
      });
    } catch (e) {}
  };

  const playChime = () => {
    try {
      const ctx = getToneCtx();
      const now = ctx.currentTime;
      [880, 1320, 1760].forEach((f, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.value = f;
        gain.gain.setValueAtTime(0.08, now + i * 0.06);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.45 + i * 0.06);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + i * 0.06);
        osc.stop(now + 0.55 + i * 0.06);
      });
    } catch (e) {}
  };

  const targetHz = (s) => s.hz * (prefs.a4 / 440);

  /* ---------- Micrófono + detección ---------- */
  const stopMic = () => {
    const e = engineRef.current;
    if (e) {
      cancelAnimationFrame(e.raf);
      e.stream.getTracks().forEach((t) => t.stop());
      try { e.ctx.close(); } catch (err) {}
    }
    engineRef.current = null;
    setMicState('idle');
    setReading(EMPTY_READING);
    setLevel(-100);
    setBars(Array(16).fill(0));
  };

  const startMic = async () => {
    setMicError('');
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setMicState('error');
      setMicError('El micrófono requiere HTTPS (o localhost) y un navegador compatible.');
      return;
    }
    setMicState('starting');
    try {
      // Debe llamarse dentro de un gesto del usuario (click/tap) para que el navegador pida permiso
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      await ctx.resume();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 4096;
      analyser.smoothingTimeConstant = 0.6;
      ctx.createMediaStreamSource(stream).connect(analyser);

      const e = {
        ctx, analyser, stream,
        buf: new Float32Array(analyser.fftSize),
        freqBuf: new Uint8Array(analyser.frequencyBinCount),
        raf: 0, last: 0, hist: [], smooth: null, lastSignal: 0, inTune: 0, locked: false, lock: null, cand: null, candCount: 0, out: 0,
      };
      engineRef.current = e;
      setEngineInfo({ sr: ctx.sampleRate, latency: Math.round(((ctx.baseLatency || 0) + (ctx.outputLatency || 0)) * 1000 * 10) / 10 });
      setMicState('on');

      const tick = (ts) => {
        if (engineRef.current !== e) return;
        e.raf = requestAnimationFrame(tick);
        if (ts - e.last < 50) return; // ~20 análisis por segundo
        e.last = ts;

        analyser.getFloatTimeDomainData(e.buf);
        let sum = 0;
        for (let i = 0; i < e.buf.length; i++) sum += e.buf[i] * e.buf[i];
        const rms = Math.sqrt(sum / e.buf.length);
        const db = rms > 0 ? 20 * Math.log10(rms) : -100;
        const c = cfgRef.current;

        analyser.getByteFrequencyData(e.freqBuf);
        const nb = Array.from({ length: 16 }, (_, i) => {
          let s = 0;
          for (let j = 0; j < 8; j++) s += e.freqBuf[2 + i * 8 + j];
          return s / 8 / 255;
        });
        setBars(nb);
        setLevel(Math.round(db));

        const res = db > c.gate ? yin(e.buf, ctx.sampleRate) : null;
        if (res && res.freq > 40 && res.freq < 1500 && res.prob > 0.85) {
          const tg = c.strings.map((s) => s.hz * (c.a4 / 440));
          // Lleva la frecuencia a la octava de la cuerda objetivo (corrige armónicos y octavas falsas)
          const fold = (hz, target, maxC) => {
            let best = null;
            [0.25, 0.5, 1, 2, 4].forEach((m) => {
              const cc = 1200 * Math.log2((hz * m) / target);
              if (Math.abs(cc) <= maxC && (best === null || Math.abs(cc) < Math.abs(best))) best = cc;
            });
            return best;
          };

          let idx = null;
          let cents0 = null;
          if (c.mode === 'manual') {
            idx = Math.max(0, c.strings.findIndex((s) => s.str === c.selected));
            cents0 = fold(res.freq, tg[idx], 600);
            e.lock = idx;
          } else {
            if (e.lock !== null && e.lock >= tg.length) e.lock = null;
            // Mientras la nota se explique con la cuerda fijada, NO se cambia de cuerda
            const lockC = e.lock !== null ? fold(res.freq, tg[e.lock], 150) : null;
            if (lockC !== null) {
              idx = e.lock;
              cents0 = lockC;
              e.cand = null;
              e.candCount = 0;
            } else {
              // Cuerda candidata: debe repetirse varios análisis seguidos antes de cambiar
              let best = Infinity, bi = -1, bc = 0;
              tg.forEach((t, i) => {
                const cc = fold(res.freq, t, 150);
                if (cc === null) return;
                const score = Math.abs(cc) + 0.1 * Math.abs(1200 * Math.log2(res.freq / t));
                if (score < best) { best = score; bi = i; bc = cc; }
              });
              if (bi >= 0) {
                e.candCount = e.cand === bi ? e.candCount + 1 : 1;
                e.cand = bi;
                if (e.candCount >= (e.lock === null ? 3 : 6)) {
                  e.lock = bi; idx = bi; cents0 = bc;
                  e.hist = []; e.smooth = null; e.inTune = 0; e.locked = false;
                }
              }
            }
          }

          if (idx !== null && cents0 !== null) {
            // Ignora saltos bruscos aislados (si se sostienen, se acepta el nuevo valor)
            let accept = true;
            const prev = e.hist.length >= 3 ? median(e.hist) : null;
            if (prev !== null && Math.abs(cents0 - prev) > 80) {
              e.out++;
              if (e.out >= 5) { e.hist = []; e.smooth = null; e.out = 0; } else accept = false;
            } else e.out = 0;

            if (accept) {
              e.hist.push(cents0);
              if (e.hist.length > 5) e.hist.shift();
              const cm = median(e.hist);
              e.smooth = e.smooth === null ? cm : e.smooth * 0.6 + cm * 0.4;
              const cents = Math.round(e.smooth * 10) / 10;
              const s = c.strings[idx];
              e.lastSignal = ts;
              setReading({ hz: Math.round(tg[idx] * Math.pow(2, cents / 1200) * 100) / 100, cents, str: s.str, signal: true, conf: res.prob });
              if (c.mode === 'auto') setSelected(s.str);

              // ¿Afinada? Debe mantenerse ~200 ms dentro de la tolerancia
              if (Math.abs(cents) <= c.tolerance) {
                e.inTune++;
                if (e.inTune === 4 && !e.locked) {
                  e.locked = true;
                  if (c.chime && !c.muted) playChime();
                  setHistory((h) => [{ t: Date.now(), note: s.note, tuning: c.tuningName, cents: Math.abs(cents) }, ...h].slice(0, 30));
                }
              } else {
                e.inTune = 0;
                if (Math.abs(cents) > c.tolerance * 2 + 2) e.locked = false;
              }
            }
          }
        } else if (ts - e.lastSignal > 1500) {
          e.hist = []; e.smooth = null; e.inTune = 0; e.locked = false; e.lock = null; e.cand = null; e.candCount = 0; e.out = 0;
          setReading((r) => (r.signal ? { ...r, signal: false } : r));
        }
      };
      e.raf = requestAnimationFrame(tick);
    } catch (err) {
      setMicState('error');
      const n = err && err.name;
      if (n === 'NotAllowedError' || n === 'SecurityError') setMicError('Permiso denegado. Habilita el micrófono para este sitio desde el candado de la barra de direcciones y vuelve a intentar.');
      else if (n === 'NotFoundError' || n === 'OverconstrainedError') setMicError('No se encontró ningún micrófono en este dispositivo.');
      else if (n === 'NotReadableError') setMicError('El micrófono está siendo usado por otra aplicación.');
      else setMicError('No se pudo iniciar el micrófono.');
    }
  };

  useEffect(() => () => {
    const e = engineRef.current;
    if (e) {
      cancelAnimationFrame(e.raf);
      e.stream.getTracks().forEach((t) => t.stop());
      try { e.ctx.close(); } catch (err) {}
      engineRef.current = null;
    }
  }, []);

  /* ---------- Afinaciones personalizadas ---------- */
  const useTuning = (t) => {
    setPref('tuningId', t.id);
    setSelected(6);
    flash(`Afinación activa: ${t.short || t.name}`);
    if (!isDesktop) setTab('tuner');
  };
  const toggleFav = (id) => setPref('favs', prefs.favs.includes(id) ? prefs.favs.filter((f) => f !== id) : [...prefs.favs, id]);
  const scrollToEditor = () => setTimeout(() => editorRef.current && editorRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);

  const startNew = () => { setDraft(newDraft(customs.length + 1)); scrollToEditor(); };
  const editTuning = (t) => {
    setDraft({ id: t.custom ? t.id : null, name: t.custom ? t.name : `${t.short} (copia)`, strings: t.strings.map((s) => ({ ...s })) });
    scrollToEditor();
  };
  const patchDraft = (i, patch) => setDraft((d) => ({ ...d, strings: d.strings.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));
  const changeNote = (i, name, oct) => {
    const note = `${name}${oct}`;
    patchDraft(i, { note, hz: noteToHz(note) });
  };

  const saveDraft = () => {
    const name = draft.name.trim() || `Mi Afinación Custom #${customs.length + 1}`;
    if (draft.strings.some((s) => !(s.hz >= 20 && s.hz <= 2000))) return flash('Cada frecuencia debe estar entre 20 y 2000 Hz');
    const id = draft.id || `custom-${Date.now()}`;
    const t = { id, name, short: name, tag: 'Custom', desc: 'Afinación personalizada', custom: true, strings: draft.strings.map((s) => ({ ...s, hz: Math.round(s.hz * 100) / 100 })) };
    const next = customs.some((c) => c.id === id) ? customs.map((c) => (c.id === id ? t : c)) : [...customs, t];
    const ok = save(CUSTOM_KEY, next);
    setCustoms(next);
    setDraft((d) => ({ ...d, id, name }));
    flash(ok ? 'Guardada en este dispositivo. Pulsa «Usar ahora» para activarla.' : 'No se pudo guardar: el navegador bloqueó el almacenamiento local');
  };

  const deleteCustom = (t) => {
    if (!window.confirm(`¿Eliminar «${t.name}»?`)) return;
    const next = customs.filter((c) => c.id !== t.id);
    save(CUSTOM_KEY, next);
    setCustoms(next);
    if (prefs.tuningId === t.id) setPref('tuningId', 'standard');
    if (draft.id === t.id) setDraft(newDraft(next.length + 1));
  };

  const exportTunings = () => {
    const blob = new Blob([JSON.stringify({ app: 'vibetune', customs }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'vibetune-afinaciones.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const importTunings = (ev) => {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const data = JSON.parse(r.result);
        const list = Array.isArray(data) ? data : data.customs;
        const valid = list.filter((t) => t && t.name && Array.isArray(t.strings) && t.strings.length === 6 && t.strings.every((s) => parseNote(s.note) && s.hz > 0));
        if (!valid.length) throw new Error('vacío');
        const imported = valid.map((t, i) => ({
          id: `custom-${Date.now()}-${i}`, name: String(t.name), short: String(t.name), tag: 'Custom', desc: 'Afinación importada', custom: true,
          strings: t.strings.map((s, k) => ({ str: 6 - k, note: s.note, hz: Number(s.hz) })),
        }));
        const next = [...customs, ...imported];
        save(CUSTOM_KEY, next);
        setCustoms(next);
        flash(`${imported.length} afinación(es) importada(s)`);
      } catch (e) {
        flash('Archivo inválido');
      }
    };
    r.readAsText(file);
  };

  const resetAll = () => {
    if (!window.confirm('Se borrarán tus afinaciones, historial y ajustes de este dispositivo.')) return;
    [PREFS_KEY, CUSTOM_KEY, HIST_KEY].forEach((k) => { try { localStorage.removeItem(k); } catch (e) {} });
    setPrefs(DEFAULT_PREFS); setCustoms([]); setHistory([]); setDraft(newDraft(1));
    flash('Datos restablecidos');
  };

  /* ============================== RENDER ============================== */
  const shown = strings.find((s) => s.str === (reading.signal ? reading.str : selected)) || strings[0];
  const sig = reading.signal;
  const cents = sig ? reading.cents : 0;
  const inTune = sig && Math.abs(cents) <= prefs.tolerance;
  const fmt = prefs.notation;

  const hint = micState !== 'on'
    ? 'Activa el micrófono para empezar'
    : !sig ? 'Toca una cuerda…'
    : inTune ? '¡PERFECTO! En afinación'
    : cents > 0 ? `Tono alto. Afloja la clavija (-${Math.abs(cents)}¢)`
    : `Tono bajo. Aprieta la clavija (+${Math.abs(cents)}¢)`;

  const arcPt = (deg) => {
    const r = (deg * Math.PI) / 180;
    return `${(120 + 100 * Math.sin(r)).toFixed(2)} ${(110 - 100 * Math.cos(r)).toFixed(2)}`;
  };

  /* ---- Medidor ---- */
  const renderGauge = () => {
    const z = prefs.tolerance * 1.8;
    const col = inTune ? '#4edea3' : '#ffb0cd';
    return (
      <div className={`${card} flex flex-col items-center gap-3 transition-all ${inTune && prefs.flash ? 'ring-2 ring-[#4edea3] shadow-[0_0_30px_rgba(78,222,163,0.25)]' : ''}`}>
        <div className="w-full flex items-center justify-between text-xs text-[#cfc2d6]">
          <span className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${micState === 'on' ? 'bg-[#4edea3] animate-pulse' : 'bg-[#988d9f]'}`}></span>
            {micState === 'on' ? 'Medidor centesimal en vivo' : 'Micrófono apagado'}
          </span>
          <span className="bg-[#201f24] px-3 py-1 rounded-full text-[#988d9f] font-semibold">
            {level > -99 ? `${level} dB` : '— dB'}
          </span>
        </div>

        <div className="relative w-full max-w-[420px]">
          <svg className="w-full" viewBox="0 0 240 125">
            <path d="M 20 110 A 100 100 0 0 1 220 110" fill="none" stroke="#3a383e" strokeWidth="5" strokeLinecap="round" />
            <path d={`M ${arcPt(-z)} A 100 100 0 0 1 ${arcPt(z)}`} fill="none" stroke="#4edea3" strokeWidth="7" strokeLinecap="round" />
            {[-50, -25, 0, 25, 50].map((t) => (
              <line key={t} x1="120" y1="16" x2="120" y2="26" stroke={t === 0 ? '#4edea3' : '#6b6472'} strokeWidth="2" transform={`rotate(${t * 1.8} 120 110)`} />
            ))}
            <g transform={`rotate(${Math.max(-50, Math.min(50, cents)) * 1.8} 120 110)`} style={{ transition: 'transform 120ms linear' }} opacity={sig ? 1 : 0.35}>
              <line x1="120" y1="110" x2="120" y2="28" stroke={col} strokeWidth="3.5" strokeLinecap="round" />
              <circle cx="120" cy="28" r="5" fill={col} />
            </g>
            <circle cx="120" cy="110" r="7" fill="#3a383e" />
            <circle cx="120" cy="110" r="3.5" fill={col} />
          </svg>
          <span className="absolute bottom-0 left-1 text-xs font-bold text-[#ffb0cd]">-50¢</span>
          <span className="absolute bottom-0 right-1 text-xs font-bold text-[#ffb0cd]">+50¢</span>
          <span className="absolute top-0 left-1/2 -translate-x-1/2 text-[11px] font-bold text-[#4edea3]">±0¢</span>
        </div>

        <div className="flex flex-col items-center text-center -mt-1">
          <div className="flex items-baseline gap-2">
            <span className="text-6xl lg:text-7xl font-black font-outfit text-[#ddb7ff] tracking-tight leading-none">
              {fmt === 'letter' ? letterOf(shown.note) : shown.note}
            </span>
            {fmt === 'full' && <span className="text-2xl font-bold text-[#cfc2d6]">({solfOf(shown.note)})</span>}
          </div>
          <div className="flex flex-wrap items-center justify-center gap-2 mt-3 text-xs">
            <span className="bg-[#201f24] px-3 py-1 rounded-full text-[#4edea3] font-bold">{sig ? reading.hz.toFixed(2) : targetHz(shown).toFixed(2)} Hz</span>
            {sig && <span className="bg-[#201f24] px-3 py-1 rounded-full text-[#ffb0cd] font-bold">{cents > 0 ? `+${cents}` : cents}¢</span>}
            <span className="text-[#988d9f] uppercase">{shown.str}.ª cuerda</span>
          </div>
          <div className={`mt-3 px-5 py-2 rounded-full text-xs font-bold flex items-center gap-2 ${inTune ? 'bg-[#00a572] text-white' : sig ? (cents > 0 ? 'bg-[#aa0266]/40 text-[#ffb0cd]' : 'bg-[#b76dff]/30 text-[#ddb7ff]') : 'bg-[#201f24] text-[#988d9f]'}`}>
            <Icon n={inTune ? 'verified' : sig ? (cents > 0 ? 'south_east' : 'north_east') : 'mic'} className="!text-[18px]" />
            {hint}
          </div>
        </div>

        <div className="w-full">
          <div className="flex justify-between text-[10px] text-[#988d9f] mb-1">
            <span>Espectro</span>
            <span>{sig ? `Pico: ${reading.hz.toFixed(1)} Hz` : 'Sin señal'}</span>
          </div>
          <div className="flex items-end gap-1 h-10 bg-[#0f0d13] rounded-lg p-1.5">
            {bars.map((v, i) => (
              <div key={i} className="flex-1 rounded-sm bg-[#b76dff]/70" style={{ height: `${Math.max(6, v * 100)}%` }}></div>
            ))}
          </div>
        </div>
      </div>
    );
  };

  /* ---- Mástil / lista de cuerdas ---- */
  const renderStrings = () => (
    <div className={card}>
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-bold font-outfit text-white flex items-center gap-2 text-base">
          <Icon n="music_note" className="text-[#ddb7ff]" /> Mástil de cuerdas
        </h3>
        <div className="grid grid-cols-2 gap-1 bg-[#0f0d13] p-1 rounded-full text-xs">
          {[['auto', 'Auto'], ['manual', 'Manual']].map(([m, l]) => (
            <button key={m} onClick={() => setPref('mode', m)} className={`px-3 py-1 rounded-full font-semibold ${prefs.mode === m ? 'bg-[#b76dff] text-[#400071]' : 'text-[#cfc2d6]'}`}>{l}</button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-1 gap-2">
        {strings.map((s) => {
          const sel = selected === s.str;
          return (
            <div
              key={s.str}
              onClick={() => { setSelected(s.str); setPref('mode', 'manual'); }}
              className={`flex items-center justify-between gap-2 p-2.5 rounded-xl cursor-pointer border transition-all ${sel ? 'bg-[#00a572]/20 border-[#4edea3]' : 'bg-[#0f0d13] border-transparent hover:border-[#4d4354]'}`}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className={`text-[11px] px-2 py-0.5 rounded-full font-bold ${sel ? 'bg-[#4edea3] text-[#002113]' : 'bg-[#2b292f] text-[#cfc2d6]'}`}>{s.str}.ª</span>
                <span className="text-sm font-bold text-white truncate">{labelOf(s.note, fmt)}</span>
              </div>
              <div className="flex items-center gap-1">
                <span className="text-[11px] text-[#988d9f] hidden sm:inline lg:inline">{targetHz(s).toFixed(1)} Hz</span>
                <button onClick={(e) => { e.stopPropagation(); playTone(targetHz(s)); }} className="p-1 text-[#988d9f] hover:text-[#ddb7ff]" aria-label="Reproducir tono">
                  <Icon n="volume_up" className="!text-[18px]" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
      <p className="text-[11px] text-[#988d9f] mt-2 lg:hidden">{targetHz(shown).toFixed(1)} Hz · {labelOf(shown.note, fmt)}</p>
    </div>
  );

  /* ---- Botones de micrófono y extras ---- */
  const renderControls = () => (
    <div className="flex flex-col gap-3">
      {micState === 'error' && (
        <div className="p-3 rounded-xl bg-[#aa0266]/20 border border-[#ffb0cd]/40 text-xs text-[#ffb0cd] flex gap-2">
          <Icon n="error" className="!text-[18px]" /> <span>{micError}</span>
        </div>
      )}
      <button
        onClick={() => (micState === 'on' ? stopMic() : startMic())}
        disabled={micState === 'starting'}
        className={`w-full py-4 rounded-xl font-bold text-sm flex items-center justify-center gap-2 shadow-lg transition-all ${micState === 'on' ? 'bg-gradient-to-r from-[#b76dff] to-[#ffb0cd] text-[#400071]' : 'bg-[#b76dff] text-[#400071]'}`}
      >
        <Icon n={micState === 'on' ? 'mic' : 'mic_off'} className={micState === 'on' ? 'animate-pulse' : ''} />
        {micState === 'starting' ? 'Solicitando permiso…' : micState === 'on' ? 'Escuchando… (toca una cuerda)' : 'Activar micrófono'}
      </button>
      <div className="grid grid-cols-3 gap-2">
        <button onClick={() => playTone(targetHz(shown))} className={`${btnGhost} py-3 flex flex-col items-center gap-1`}>
          <Icon n="sensors" className="text-[#4edea3]" /> Tono {Math.round(targetHz(shown))}Hz
        </button>
        <button onClick={() => playTone(targetHz(shown), true)} className={`${btnGhost} py-3 flex flex-col items-center gap-1`}>
          <Icon n="blur_on" className="text-[#4edea3]" /> Armónicos
        </button>
        <button onClick={() => setMuted((m) => !m)} className={`${btnGhost} py-3 flex flex-col items-center gap-1 ${muted ? '!bg-[#aa0266]/30' : ''}`}>
          <Icon n={muted ? 'volume_off' : 'volume_up'} className="text-[#4edea3]" /> {muted ? 'Silenciado' : 'Silencio'}
        </button>
      </div>
    </div>
  );

  /* ---- Selector de formato de notas ---- */
  const renderNotation = () => (
    <div className={card}>
      <h3 className="font-bold font-outfit text-white flex items-center gap-2 mb-1"><Icon n="visibility" className="text-[#ddb7ff]" /> Formato de visualización</h3>
      <p className="text-xs text-[#988d9f] mb-3">Cómo se muestran las notas en las cuerdas y en el dial.</p>
      <div className="grid grid-cols-2 gap-2 bg-[#0f0d13] p-1 rounded-xl text-xs">
        <button onClick={() => setPref('notation', 'full')} className={`py-2.5 rounded-lg font-semibold ${fmt === 'full' ? 'bg-[#b76dff] text-[#400071]' : 'text-[#cfc2d6]'}`}>Nota completa<br /><span className="opacity-70">E2 (Mi)</span></button>
        <button onClick={() => setPref('notation', 'letter')} className={`py-2.5 rounded-lg font-semibold ${fmt === 'letter' ? 'bg-[#b76dff] text-[#400071]' : 'text-[#cfc2d6]'}`}>Solo letra<br /><span className="opacity-70">E</span></button>
      </div>
      <div className="grid grid-cols-6 gap-1 mt-3">
        {strings.map((s) => (
          <div key={s.str} className="bg-[#0f0d13] rounded-lg py-2 text-center">
            <div className="text-[9px] text-[#988d9f]">{s.str}.ª</div>
            <div className="text-xs font-bold text-white">{fmt === 'letter' ? letterOf(s.note) : s.note}</div>
            {fmt === 'full' && <div className="text-[10px] text-[#ddb7ff]">({solfOf(s.note)})</div>}
          </div>
        ))}
      </div>
    </div>
  );

  /* ---- Tarjeta de afinación ---- */
  const renderTuningCard = (t) => {
    const isActive = t.id === active.id;
    const fav = prefs.favs.includes(t.id);
    return (
      <div key={t.id} className={`rounded-2xl border p-4 flex flex-col gap-3 ${isActive ? 'bg-[#201f24] border-[#ddb7ff]' : 'bg-[#1c1b20] border-[#2b292f]'}`}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-bold text-white leading-snug">{t.name}</div>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#b76dff]/20 text-[#ddb7ff] font-bold">{t.tag}</span>
              <span className="text-[11px] text-[#988d9f]">{t.desc}</span>
            </div>
          </div>
          <button onClick={() => toggleFav(t.id)} className={fav ? 'text-[#ffd479]' : 'text-[#988d9f]'} aria-label="Favorita">
            <Icon n={fav ? 'star' : 'star_outline'} />
          </button>
        </div>
        <div className="grid grid-cols-6 gap-1">
          {t.strings.map((s) => (
            <div key={s.str} className="bg-[#0f0d13] rounded-lg py-1.5 text-center">
              <div className="text-[9px] text-[#988d9f]">{s.str}.ª</div>
              <div className="text-xs font-bold text-white">{fmt === 'letter' ? letterOf(s.note) : s.note}</div>
              {fmt === 'full' && <div className="text-[9px] text-[#ddb7ff]">{solfOf(s.note)}</div>}
              <div className="text-[9px] text-[#988d9f]">{Math.round(s.hz)}Hz</div>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => useTuning(t)} className={`flex-1 py-2 rounded-xl text-xs font-bold ${isActive ? 'bg-[#00a572] text-white' : 'bg-[#b76dff] text-[#400071]'}`}>
            {isActive ? 'En uso' : 'Usar ahora'}
          </button>
          <button onClick={() => editTuning(t)} className={`${btnGhost} px-3 py-2`}>{t.custom ? 'Editar' : 'Duplicar'}</button>
          {t.custom && (
            <button onClick={() => deleteCustom(t)} className="px-2 py-2 rounded-xl text-[#ffb0cd] border border-[#4d4354] bg-[#201f24]" aria-label="Eliminar">
              <Icon n="delete" className="!text-[18px]" />
            </button>
          )}
        </div>
      </div>
    );
  };

  /* ---- Editor de 6 cuerdas ---- */
  const renderEditor = () => (
    <div className={card} ref={editorRef}>
      <div className="flex items-center justify-between mb-1">
        <h3 className="font-bold font-outfit text-white flex items-center gap-2"><Icon n="tune" className="text-[#ddb7ff]" /> Editor de 6 cuerdas</h3>
        <button onClick={() => setDraft(newDraft(customs.length + 1))} className="text-xs text-[#ddb7ff] flex items-center gap-1"><Icon n="restart_alt" className="!text-[16px]" /> Reset</button>
      </div>
      <p className="text-xs text-[#988d9f] mb-3">Elige nota y octava; la frecuencia se calcula sola y también puedes ajustarla a mano.</p>
      <label className="text-[10px] uppercase text-[#988d9f] font-semibold">Nombre de la afinación</label>
      <input
        type="text" value={draft.name} maxLength={40}
        onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
        className="w-full mt-1 mb-3 bg-[#0f0d13] border border-[#4d4354] rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-[#ddb7ff]"
      />
      <div className="flex flex-col gap-2">
        {draft.strings.map((s, i) => {
          const { name, oct } = parseNote(s.note);
          return (
            <div key={s.str} className="flex items-center gap-1.5 bg-[#0f0d13] p-1.5 rounded-xl">
              <span className="w-7 text-center text-[11px] font-bold text-[#988d9f]">{s.str}.ª</span>
              <select value={name} onChange={(e) => changeNote(i, e.target.value, oct)} className="bg-[#201f24] text-white text-xs rounded-lg px-1.5 py-2 border border-[#4d4354] w-[78px]">
                {NOTE_NAMES.map((n) => <option key={n} value={n}>{n} ({SOLF[n[0]]}{n.slice(1)})</option>)}
              </select>
              <select value={oct} onChange={(e) => changeNote(i, name, parseInt(e.target.value, 10))} className="bg-[#201f24] text-white text-xs rounded-lg px-1.5 py-2 border border-[#4d4354] w-[48px]">
                {OCTAVES.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
              <input
                type="number" step="0.01" value={s.hz}
                onChange={(e) => patchDraft(i, { hz: parseFloat(e.target.value) || 0 })}
                className="min-w-0 flex-1 bg-[#201f24] text-[#4edea3] font-bold text-xs text-right rounded-lg px-2 py-2 border border-[#4d4354]"
              />
              <span className="text-[10px] text-[#988d9f]">Hz</span>
              <button onClick={() => playTone(s.hz * (prefs.a4 / 440))} className="p-1 text-[#988d9f] hover:text-[#ddb7ff]" aria-label="Probar tono"><Icon n="volume_up" className="!text-[18px]" /></button>
            </div>
          );
        })}
      </div>
      <button onClick={saveDraft} className="w-full mt-3 py-3 rounded-xl bg-[#b76dff] text-[#400071] font-bold text-sm flex items-center justify-center gap-2">
        <Icon n="save" /> {draft.id ? 'Actualizar afinación' : 'Guardar en almacenamiento local'}
      </button>
      <div className="grid grid-cols-2 gap-2 mt-2">
        <button onClick={exportTunings} disabled={!customs.length} className={`${btnGhost} py-2.5 flex items-center justify-center gap-1 disabled:opacity-40`}><Icon n="download" className="!text-[16px]" /> Exportar</button>
        <button onClick={() => fileRef.current && fileRef.current.click()} className={`${btnGhost} py-2.5 flex items-center justify-center gap-1`}><Icon n="upload" className="!text-[16px]" /> Importar</button>
        <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={importTunings} />
      </div>
    </div>
  );

  /* ---- Página de afinaciones ---- */
  const renderTuningsPage = () => (
    <div className="flex flex-col gap-4">
      <div className={card}>
        <h2 className="text-xl font-bold font-outfit text-white flex items-center gap-2"><Icon n="queue_music" className="text-[#ddb7ff]" /> Mis afinaciones</h2>
        <p className="text-xs text-[#988d9f] mt-1 mb-3">Crea y gestiona afinaciones para acústica y eléctrica. Se guardan en este dispositivo.</p>
        <button onClick={startNew} className="w-full py-3.5 rounded-xl bg-gradient-to-r from-[#b76dff] to-[#ffb0cd] text-[#400071] font-bold text-sm flex items-center justify-center gap-2">
          <Icon n="add_circle" /> Nueva afinación personalizada
        </button>
      </div>
      {renderNotation()}
      <div className={isDesktop ? 'grid grid-cols-2 gap-4 items-start' : 'flex flex-col gap-4'}>
        <div className="flex flex-col gap-3">
          <div className="text-xs text-[#988d9f] font-semibold px-1">Afinaciones guardadas · {allTunings.length}</div>
          {allTunings.map(renderTuningCard)}
        </div>
        {renderEditor()}
      </div>
    </div>
  );

  /* ---- Ajustes / calibración ---- */
  const Toggle = ({ label, icon, value, onChange }) => (
    <label className="flex items-center justify-between p-3 rounded-xl bg-[#0f0d13] border border-[#2b292f] cursor-pointer">
      <span className="flex items-center gap-2 text-xs font-semibold text-white"><Icon n={icon} className="!text-[18px] text-[#4edea3]" />{label}</span>
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} className="w-4 h-4 accent-[#4edea3]" />
    </label>
  );

  const renderSettings = () => (
    <div className={`${card} flex flex-col gap-5`}>
      <h2 className="text-lg font-bold font-outfit flex items-center gap-2 text-white"><Icon n="equalizer" className="text-[#4edea3]" /> Calibración y DSP</h2>

      <div className="flex flex-col gap-2">
        <div className="flex justify-between text-xs"><span className="text-[#988d9f] uppercase font-semibold">Referencia A4</span><span className="text-[#ddb7ff] font-bold">{prefs.a4} Hz</span></div>
        <div className="grid grid-cols-2 gap-1 bg-[#0f0d13] p-1 rounded-xl text-xs">
          <button onClick={() => setPref('a4', 440)} className={`py-1.5 rounded-lg ${prefs.a4 === 440 ? 'bg-[#b76dff] text-[#400071] font-bold' : 'text-[#cfc2d6]'}`}>440 Hz estándar</button>
          <button onClick={() => setPref('a4', 432)} className={`py-1.5 rounded-lg ${prefs.a4 === 432 ? 'bg-[#b76dff] text-[#400071] font-bold' : 'text-[#cfc2d6]'}`}>432 Hz</button>
        </div>
        <div className="flex items-center justify-between bg-[#0f0d13] p-1.5 rounded-xl border border-[#2b292f]">
          <button onClick={() => setPref('a4', Math.max(410, prefs.a4 - 1))} className="w-9 h-9 rounded-lg bg-[#201f24] hover:bg-[#36343a] text-white font-bold">−</button>
          <span className="text-sm font-bold text-white">{prefs.a4.toFixed(1)} Hz</span>
          <button onClick={() => setPref('a4', Math.min(470, prefs.a4 + 1))} className="w-9 h-9 rounded-lg bg-[#201f24] hover:bg-[#36343a] text-white font-bold">+</button>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex justify-between text-xs"><span className="text-[#988d9f] uppercase font-semibold">Entrada del micrófono</span><span className="text-[#4edea3] font-bold">{level > -99 ? `${level} dB` : '— dB'}</span></div>
        <div className="h-2 rounded-full bg-[#0f0d13] overflow-hidden">
          <div className="h-full bg-gradient-to-r from-[#4edea3] to-[#ffb0cd] transition-all" style={{ width: `${Math.max(0, Math.min(100, ((level + 80) / 80) * 100))}%` }}></div>
        </div>
        <div className="flex justify-between text-xs mt-1"><span className="text-[#988d9f]">Compuerta de ruido</span><span className="text-[#ddb7ff] font-bold">{prefs.gate} dB</span></div>
        <input type="range" min="-70" max="-25" step="1" value={prefs.gate} onChange={(e) => setPref('gate', parseInt(e.target.value, 10))} className="w-full accent-[#ddb7ff]" />
        <div className="flex justify-between text-[10px] text-[#988d9f]"><span>Sensible (estudio)</span><span>Aislante (escenario)</span></div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-xs uppercase text-[#988d9f] font-semibold">Tolerancia de detección</span>
        <div className="grid grid-cols-3 gap-1 bg-[#0f0d13] p-1 rounded-xl text-xs">
          {[[1, 'Estricto'], [3, 'Estándar'], [5, 'Relajado']].map(([v, l]) => (
            <button key={v} onClick={() => setPref('tolerance', v)} className={`py-1.5 rounded-lg ${prefs.tolerance === v ? 'bg-[#b76dff] text-[#400071] font-bold' : 'text-[#cfc2d6]'}`}>±{v}¢<br />{l}</button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-xs uppercase text-[#988d9f] font-semibold">Respuesta y feedback</span>
        <Toggle label="Chime al afinar" icon="notifications_active" value={prefs.chime} onChange={(v) => setPref('chime', v)} />
        <Toggle label="Respuesta visual / flash" icon="flash_on" value={prefs.flash} onChange={(v) => setPref('flash', v)} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-xs uppercase text-[#988d9f] font-semibold">Formato de notas</span>
        <div className="grid grid-cols-2 gap-1 bg-[#0f0d13] p-1 rounded-xl text-xs">
          <button onClick={() => setPref('notation', 'full')} className={`py-1.5 rounded-lg ${fmt === 'full' ? 'bg-[#b76dff] text-[#400071] font-bold' : 'text-[#cfc2d6]'}`}>E2 (Mi)</button>
          <button onClick={() => setPref('notation', 'letter')} className={`py-1.5 rounded-lg ${fmt === 'letter' ? 'bg-[#b76dff] text-[#400071] font-bold' : 'text-[#cfc2d6]'}`}>E</button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        {[
          ['Latencia', engineInfo.sr ? `${engineInfo.latency} ms` : '—'],
          ['Buffer', '4096 frames'],
          ['Sample rate', engineInfo.sr ? `${engineInfo.sr.toLocaleString('en-US')} Hz` : '—'],
          ['Confianza', sig ? `${Math.round(reading.conf * 100)}%` : '—'],
        ].map(([k, v]) => (
          <div key={k} className="bg-[#0f0d13] border border-[#2b292f] rounded-xl p-2.5">
            <div className="text-[10px] uppercase text-[#988d9f]">{k}</div>
            <div className="font-bold text-white">{v}</div>
          </div>
        ))}
      </div>

      <button onClick={resetAll} className="text-xs text-[#ffb0cd] border border-[#4d4354] rounded-xl py-2.5 bg-[#201f24]">Borrar datos locales</button>
    </div>
  );

  /* ---- Historial ---- */
  const renderHistory = () => (
    <div className={`${card} flex flex-col gap-3`}>
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold font-outfit text-white flex items-center gap-2"><Icon n="history" className="text-[#ddb7ff]" /> Historial</h2>
        {history.length > 0 && <button onClick={() => setHistory([])} className="text-xs text-[#ffb0cd]">Limpiar</button>}
      </div>
      {history.length === 0 && <p className="text-sm text-[#988d9f]">Aún no hay cuerdas afinadas. Activa el micrófono y afina una cuerda para registrarla aquí.</p>}
      {history.map((h, i) => (
        <div key={h.t + '-' + i} className="flex items-center justify-between bg-[#0f0d13] rounded-xl p-3 text-sm">
          <div>
            <div className="font-bold text-white">{labelOf(h.note, fmt)}</div>
            <div className="text-[11px] text-[#988d9f]">{h.tuning}</div>
          </div>
          <div className="text-right">
            <div className="text-[#4edea3] font-bold text-xs">±{h.cents.toFixed(1)}¢</div>
            <div className="text-[11px] text-[#988d9f]">{new Date(h.t).toLocaleString('es-CL', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' })}</div>
          </div>
        </div>
      ))}
    </div>
  );

  /* ---- Barra superior móvil del afinador ---- */
  const renderQuickBar = () => (
    <div className="flex items-center gap-2 p-2.5 rounded-2xl bg-[#1c1b20] border border-[#2b292f]">
      <button onClick={() => setTab('tunings')} className="flex items-center gap-2 text-left flex-1 min-w-0">
        <span className="w-9 h-9 rounded-xl bg-[#201f24] flex items-center justify-center text-[#ddb7ff]"><Icon n="tune" /></span>
        <span className="min-w-0">
          <span className="block text-[10px] text-[#988d9f] uppercase">Afinación activa</span>
          <span className="block text-sm font-bold text-white truncate">{active.short || active.name}</span>
        </span>
      </button>
      <button onClick={() => setPref('notation', fmt === 'full' ? 'letter' : 'full')} className="px-3 py-2 rounded-full bg-[#2b292f] text-[#ddb7ff] text-xs font-bold flex items-center gap-1">
        <Icon n="translate" className="!text-[16px]" />{fmt === 'full' ? 'E2 (Mi)' : 'E'}
      </button>
      <button onClick={() => setTab('settings')} className="px-3 py-2 rounded-full bg-[#2b292f] text-[#4edea3] text-xs font-bold">A4 {prefs.a4}</button>
    </div>
  );

  const tunerCore = (
    <div className="flex flex-col gap-4">
      {!isDesktop && renderQuickBar()}
      {renderGauge()}
      {renderStrings()}
      {renderControls()}
    </div>
  );

  let content;
  if (isDesktop && tab === 'tuner') {
    content = (
      <div className="grid grid-cols-12 gap-6 items-start">
        <aside className="col-span-3 flex flex-col gap-4">
          {renderNotation()}
          <div className="text-xs text-[#988d9f] font-semibold px-1">Presets y afinaciones guardadas</div>
          {allTunings.map(renderTuningCard)}
          {renderEditor()}
        </aside>
        <section className="col-span-6 flex flex-col gap-4">{tunerCore}</section>
        <aside className="col-span-3">{renderSettings()}</aside>
      </div>
    );
  } else if (tab === 'tuner') content = tunerCore;
  else if (tab === 'tunings') content = renderTuningsPage();
  else if (tab === 'history') content = <div className="max-w-2xl mx-auto w-full">{renderHistory()}</div>;
  else content = <div className="max-w-2xl mx-auto w-full">{renderSettings()}</div>;

  return (
    <div className="min-h-screen bg-[#141318] text-[#e6e1e8] flex flex-col pb-20 lg:pb-8">
      <header className="fixed top-0 w-full z-50 bg-[#141318]/85 backdrop-blur-xl border-b border-[#2b292f]">
        <div className="h-16 lg:h-20 px-4 lg:px-8 flex items-center justify-between max-w-[1720px] mx-auto">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-[#201f24] flex items-center justify-center text-[#ddb7ff] relative">
              <Icon n="graphic_eq" />
              <span className={`absolute top-1.5 right-1.5 w-2 h-2 rounded-full ${micState === 'on' ? 'bg-[#4edea3] animate-pulse' : 'bg-[#988d9f]'}`}></span>
            </div>
            <div className="flex flex-col">
              <span className="text-[10px] text-[#ddb7ff] uppercase tracking-wider font-bold">VibeTune Pro</span>
              <h1 className="text-base lg:text-lg font-bold font-outfit leading-none">Studio Tuner</h1>
            </div>
          </div>
          <nav className="hidden lg:flex items-center gap-1 bg-[#1c1b20] p-1.5 rounded-xl">
            {TABS.map((t) => (
              <button key={t.id} onClick={() => setTab(t.id)} className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all ${tab === t.id ? 'bg-[#b76dff] text-[#400071]' : 'text-[#cfc2d6] hover:text-white'}`}>{t.label}</button>
            ))}
          </nav>
          <div className="flex items-center gap-2 bg-[#1c1b20] px-3 py-1.5 rounded-full text-xs">
            <span className={`w-2 h-2 rounded-full ${micState === 'on' ? 'bg-[#4edea3]' : 'bg-[#988d9f]'}`}></span>
            <span className={`font-bold ${micState === 'on' ? 'text-[#4edea3]' : 'text-[#988d9f]'}`}>{level > -99 ? `${level} dB` : '— dB'}</span>
            <span className="text-[#988d9f] hidden sm:inline">| A4 {prefs.a4}Hz</span>
          </div>
        </div>
      </header>

      <main className="pt-20 lg:pt-28 px-4 lg:px-8 max-w-[1720px] mx-auto w-full flex-1">{content}</main>

      {toast && (
        <div className="fixed bottom-24 lg:bottom-8 left-1/2 -translate-x-1/2 z-[60] bg-[#2b292f] border border-[#4d4354] text-white text-xs font-semibold px-4 py-2.5 rounded-full shadow-xl max-w-[90vw] text-center">{toast}</div>
      )}

      <nav className="lg:hidden fixed bottom-0 w-full z-50 bg-[#141318]/95 backdrop-blur-xl border-t border-[#2b292f] h-16 flex justify-around items-center">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} className={`flex flex-col items-center gap-0.5 text-[11px] font-semibold px-3 ${tab === t.id ? 'text-[#ddb7ff]' : 'text-[#988d9f]'}`}>
            <Icon n={t.icon} />{t.label}
          </button>
        ))}
      </nav>
    </div>
  );
}