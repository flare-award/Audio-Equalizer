/* ==========================================================================
   Audio Equalizer
   Эквалайзер на Web Audio API: предусилитель → баланс/моно → 10 полос →
   анализатор → громкость → выход. Всё работает локально в браузере.
   ========================================================================== */

(() => {
  'use strict';

  /* ---------------------------------------------------------------------
   * Константы
   * ------------------------------------------------------------------- */

  const BANDS = [60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000];
  const LABELS = ['60', '170', '310', '600', '1k', '3k', '6k', '12k', '14k', '16k'];
  const DB_MAX = 12;
  const STORAGE_KEY = 'iea-settings-v2';
  const AUDIO_EXT = /\.(mp3|wav|ogg|oga|flac|m4a|aac|opus|webm|weba)$/i;

  const PRESETS = {
    'Плоский': [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    'Бас': [7, 6, 5, 3, 1, 0, 0, 0, 0, 0],
    'Рок': [5, 4, 2, -1, -2, -1, 2, 3, 4, 4],
    'Поп': [-1, 2, 4, 5, 3, 0, -1, -1, -1, -1],
    'Вокал': [-3, -2, 0, 3, 5, 5, 3, 1, 0, -1],
    'Классика': [3, 2, 1, 0, -1, -1, 0, 2, 3, 4],
    'Электро': [5, 4, 1, 0, -2, 2, 1, 2, 4, 5],
    'Высокие': [0, 0, 0, 0, 0, 1, 3, 4, 5, 5],
    'Ночь': [-2, -1, 0, 1, 2, 2, 1, -1, -3, -5],
  };

  const DEFAULTS = {
    enabled: true,
    preamp: 0,
    pan: 0,
    mono: false,
    bands: BANDS.map(() => 0),
    volume: 0.8,
    shuffle: false,
    repeat: 'off', // off | all | one
  };

  /* ---------------------------------------------------------------------
   * Утилиты
   * ------------------------------------------------------------------- */

  const $ = (sel) => document.querySelector(sel);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const snap = (v) => Math.round(v * 2) / 2; // шаг 0.5 дБ
  const dbToLin = (db) => Math.pow(10, db / 20);
  const pad = (n) => String(n).padStart(2, '0');

  const fmtTime = (s) => {
    if (!isFinite(s) || s < 0) s = 0;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
  };

  const fmtDb = (v) => (v > 0 ? '+' : '') + (Number.isInteger(v) ? String(v) : v.toFixed(1));

  const plural = (n, one, few, many) => {
    const m10 = n % 10;
    const m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  };

  const cleanName = (name) => name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim() || 'Без названия';

  const isAudioFile = (f) => (f.type && f.type.startsWith('audio/')) || AUDIO_EXT.test(f.name);

  /* ---------------------------------------------------------------------
   * Состояние и хранение
   * ------------------------------------------------------------------- */

  function loadState() {
    const s = { ...DEFAULTS, bands: [...DEFAULTS.bands] };
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      for (const key of Object.keys(DEFAULTS)) {
        if (key in saved && typeof saved[key] === typeof DEFAULTS[key]) {
          s[key] = saved[key];
        }
      }
      if (!Array.isArray(s.bands) || s.bands.length !== BANDS.length) {
        s.bands = [...DEFAULTS.bands];
      }
      s.bands = s.bands.map((v) => clamp(Number(v) || 0, -DB_MAX, DB_MAX));
      s.preamp = clamp(s.preamp, -DB_MAX, DB_MAX);
      s.pan = clamp(s.pan, -1, 1);
      s.volume = clamp(s.volume, 0, 1);
      if (!['off', 'all', 'one'].includes(s.repeat)) s.repeat = 'off';
    } catch (e) {
      /* повреждённые настройки — просто берём значения по умолчанию */
    }
    return s;
  }

  const state = loadState();

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      /* хранилище недоступно — настройки просто не сохранятся */
    }
  }

  const presetName = () => {
    for (const [name, values] of Object.entries(PRESETS)) {
      if (values.every((v, i) => v === state.bands[i])) return name;
    }
    return null;
  };

  /* ---------------------------------------------------------------------
   * Элементы
   * ------------------------------------------------------------------- */

  const audio = $('#audio');
  const player = $('#player');
  const eqCard = $('#eqCard');
  const titleEl = $('#title');
  const subtitleEl = $('#subtitle');
  const curEl = $('#cur');
  const durEl = $('#dur');
  const seekEl = $('#seek');
  const volumeEl = $('#volume');
  const playBtn = $('#playBtn');
  const prevBtn = $('#prevBtn');
  const nextBtn = $('#nextBtn');
  const shuffleBtn = $('#shuffleBtn');
  const repeatBtn = $('#repeatBtn');
  const playlistEl = $('#playlist');
  const libCountEl = $('#libCount');
  const fileInput = $('#fileInput');
  const dropzone = $('#dropzone');
  const overlay = $('#overlay');
  const urlForm = $('#urlForm');
  const urlInput = $('#urlInput');
  const toastEl = $('#toast');

  /* ---------------------------------------------------------------------
   * Аудиограф
   * ------------------------------------------------------------------- */

  let ctx = null;
  let graph = null; // { source, preamp, splitter, matrix, pan, filters, analyser, master }
  let graphFailed = false;

  const gainNode = (value) => {
    const g = ctx.createGain();
    g.gain.value = value;
    return g;
  };

  function buildGraph() {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();

    // Один раз привязываем элемент к Web Audio — дальше только меняем src.
    const source = ctx.createMediaElementSource(audio);

    // Предусилитель. channelCount=2 + speakers: моно-файл корректно разойдётся на два канала.
    const preamp = ctx.createGain();
    preamp.channelCount = 2;
    preamp.channelCountMode = 'explicit';
    preamp.channelInterpretation = 'speakers';

    // Моно: матрица 2×2 (LL, LR, RL, RR) — в стерео её «сводим» в центр.
    const splitter = ctx.createChannelSplitter(2);
    const merger = ctx.createChannelMerger(2);
    const matrix = { ll: gainNode(1), lr: gainNode(0), rl: gainNode(0), rr: gainNode(1) };

    splitter.connect(matrix.ll, 0);
    splitter.connect(matrix.lr, 0);
    splitter.connect(matrix.rl, 1);
    splitter.connect(matrix.rr, 1);
    matrix.ll.connect(merger, 0, 0);
    matrix.rl.connect(merger, 0, 0);
    matrix.lr.connect(merger, 0, 1);
    matrix.rr.connect(merger, 0, 1);

    const pan = ctx.createStereoPanner();

    const filters = BANDS.map((freq, i) => {
      const f = ctx.createBiquadFilter();
      f.type = i === 0 ? 'lowshelf' : i === BANDS.length - 1 ? 'highshelf' : 'peaking';
      f.frequency.value = freq;
      f.Q.value = 1;
      f.gain.value = state.bands[i];
      return f;
    });

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.8;

    const master = gainNode(state.volume);

    // Сборка цепочки
    preamp.connect(splitter);
    merger.connect(pan);
    let node = pan;
    for (const f of filters) {
      node.connect(f);
      node = f;
    }
    node.connect(analyser);
    analyser.connect(master);
    master.connect(ctx.destination);

    graph = { source, preamp, splitter, matrix, pan, filters, analyser, master };

    routeSource();
    applyParams(true);
  }

  // Включён ли эквалайзер: если нет — сигнал идёт мимо обработки (но через анализатор и громкость).
  function routeSource() {
    if (!graph) return;
    graph.source.disconnect();
    if (state.enabled) {
      graph.source.connect(graph.preamp);
    } else {
      graph.source.connect(graph.analyser);
    }
  }

  // Применяем все параметры из state к аудиоцепочке
  function applyParams(instant = false) {
    if (!graph) return;
    const t = ctx.currentTime;
    const tc = instant ? 0.001 : 0.02;
    const set = (param, value) => param.setTargetAtTime(value, t, tc);

    set(graph.preamp.gain, dbToLin(state.preamp));
    set(graph.pan.pan, state.pan);

    const m = graph.matrix;
    if (state.mono) {
      set(m.ll.gain, 0.5);
      set(m.lr.gain, 0.5);
      set(m.rl.gain, 0.5);
      set(m.rr.gain, 0.5);
    } else {
      set(m.ll.gain, 1);
      set(m.lr.gain, 0);
      set(m.rl.gain, 0);
      set(m.rr.gain, 1);
    }

    graph.filters.forEach((f, i) => set(f.gain, state.bands[i]));
    set(graph.master.gain, state.volume);
  }

  function ensureAudioContext() {
    if (!graph && !graphFailed) {
      try {
        buildGraph();
      } catch (e) {
        graphFailed = true;
        console.error(e);
        toast('Эквалайзер недоступен в этом браузере — музыка будет без обработки');
      }
    }
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
  }

  /* ---------------------------------------------------------------------
   * Библиотека и плейлист
   * ------------------------------------------------------------------- */

  let tracks = [];       // { id, title, url, objectUrl, remote, duration, broken }
  let current = -1;
  let uid = 0;
  let history = [];      // стек сыгранных треков (для «назад»)
  let played = new Set();// для перемешивания

  function addTracks(list) {
    tracks.push(...list);
    renderPlaylist();
    updateLibCount();
  }

  function addFiles(files) {
    const list = [];
    let skipped = 0;
    for (const f of files) {
      if (!isAudioFile(f)) {
        skipped++;
        continue;
      }
      list.push({
        id: ++uid,
        title: cleanName(f.name),
        url: URL.createObjectURL(f),
        objectUrl: true,
        remote: false,
        duration: NaN,
        broken: false,
      });
    }
    if (!list.length && !skipped) return;
    const firstNew = tracks.length;
    addTracks(list);

    const parts = [];
    if (list.length) parts.push(`Добавлено: ${list.length} ${plural(list.length, 'трек', 'трека', 'треков')}`);
    if (skipped) parts.push(`пропущено файлов, которые не являются аудио: ${skipped}`);
    if (parts.length) toast(parts.join(' · '));

    if (list.length && current === -1) loadTrack(firstNew, false);
  }

  function addRemoteUrl(raw) {
    let u;
    try {
      u = new URL(raw.trim());
    } catch (e) {
      toast('Похоже, ссылка некорректна');
      return false;
    }
    if (!/^https?:$/.test(u.protocol)) {
      toast('Нужна ссылка с http:// или https://');
      return false;
    }
    let title = u.hostname;
    const last = u.pathname.split('/').filter(Boolean).pop();
    if (last) {
      try {
        title = decodeURIComponent(last);
      } catch (e) {
        title = last;
      }
    }
    addTracks([{
      id: ++uid,
      title: cleanName(title),
      url: u.href,
      objectUrl: false,
      remote: true,
      duration: NaN,
      broken: false,
    }]);
    if (current === -1) loadTrack(tracks.length - 1, false);
    toast('Ссылка добавлена — нажмите ▶, чтобы слушать');
    return true;
  }

  function updateLibCount() {
    libCountEl.textContent = tracks.length
      ? `${tracks.length} ${plural(tracks.length, 'трек', 'трека', 'треков')} в библиотеке`
      : 'Пока пусто';
  }

  function renderPlaylist() {
    playlistEl.textContent = '';
    if (!tracks.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'Здесь появятся ваши треки — добавьте первый!';
      playlistEl.append(li);
      return;
    }

    const playing = current >= 0 && !audio.paused;

    tracks.forEach((t, i) => {
      const li = document.createElement('li');
      li.className = 'track' + (i === current ? ' active' : '') + (t.broken ? ' broken' : '');

      const playBtnEl = document.createElement('button');
      playBtnEl.type = 'button';
      playBtnEl.className = 'track-play';
      playBtnEl.setAttribute('aria-label', `Играть: ${t.title}`);

      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = i === current && playing ? '♪' : String(i + 1);

      const name = document.createElement('span');
      name.className = 'tt';
      name.textContent = t.title;
      name.title = t.title;

      playBtnEl.append(num, name);
      playBtnEl.addEventListener('click', () => {
        if (i === current) {
          togglePlay();
        } else {
          loadTrack(i, true);
        }
      });

      const dur = document.createElement('span');
      dur.className = 'td';
      dur.textContent = isFinite(t.duration) ? fmtTime(t.duration) : (t.remote ? 'поток' : '');

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'track-del';
      del.textContent = '×';
      del.title = 'Удалить из библиотеки';
      del.setAttribute('aria-label', `Удалить: ${t.title}`);
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        removeTrack(i);
      });

      li.append(playBtnEl, dur, del);
      playlistEl.append(li);
    });
  }

  function resetNowPlaying() {
    titleEl.textContent = 'Ничего не выбрано';
    subtitleEl.textContent = 'Добавьте треки в библиотеку ниже';
    curEl.textContent = '0:00';
    durEl.textContent = '0:00';
    seekEl.max = 0;
    seekEl.value = 0;
    paintRange(seekEl);
    updateMediaSession();
  }

  function loadTrack(i, autoplay = false, fromHistory = false) {
    const t = tracks[i];
    if (!t) return;

    if (!fromHistory && current >= 0 && current !== i) history.push(current);
    current = i;
    played.add(i);

    audio.src = t.url;
    titleEl.textContent = t.title;
    subtitleEl.textContent = t.remote ? 'Поток по ссылке' : 'Из библиотеки';
    curEl.textContent = '0:00';
    durEl.textContent = isFinite(t.duration) ? fmtTime(t.duration) : '0:00';
    seekEl.value = 0;
    seekEl.max = 0;
    paintRange(seekEl);

    renderPlaylist();
    scrollActiveIntoList();
    updateMediaSession();

    if (autoplay) play();
  }

  // Прокручиваем только сам список, не всю страницу
  function scrollActiveIntoList() {
    const active = playlistEl.querySelector('.track.active');
    if (!active) return;
    const top = active.offsetTop - playlistEl.offsetTop;
    const bottom = top + active.offsetHeight;
    if (top < playlistEl.scrollTop) {
      playlistEl.scrollTop = top;
    } else if (bottom > playlistEl.scrollTop + playlistEl.clientHeight) {
      playlistEl.scrollTop = bottom - playlistEl.clientHeight;
    }
  }

  function play() {
    if (current < 0) {
      if (!tracks.length) {
        toast('Сначала добавьте музыку — файлом или ссылкой');
        return;
      }
      loadTrack(0, false);
    }
    ensureAudioContext();
    const p = audio.play();
    if (p && p.catch) {
      p.catch((err) => {
        if (err && err.name === 'NotAllowedError') return;
        toast('Не удалось начать воспроизведение');
      });
    }
  }

  function pause() {
    audio.pause();
  }

  function togglePlay() {
    if (audio.paused) play();
    else pause();
  }

  function pickNext(dir) {
    if (!tracks.length) return -1;

    if (state.shuffle) {
      let candidates = tracks.map((_, i) => i).filter((i) => !played.has(i));
      if (!candidates.length) {
        if (state.repeat !== 'all') return -1;
        // все треки сыграны — начинаем круг заново
        played = new Set([current]);
        candidates = tracks.map((_, i) => i).filter((i) => i !== current);
        if (!candidates.length) return current;
      }
      return candidates[Math.floor(Math.random() * candidates.length)];
    }

    const n = current + dir;
    if (n >= tracks.length) return state.repeat === 'all' ? 0 : -1;
    if (n < 0) return state.repeat === 'all' ? tracks.length - 1 : -1;
    return n;
  }

  function nextTrack() {
    const n = pickNext(1);
    if (n === -1) {
      pause();
      audio.currentTime = 0;
      seekEl.value = 0;
      paintRange(seekEl);
      curEl.textContent = '0:00';
      return;
    }
    loadTrack(n, true);
  }

  function prevTrack() {
    // Если трек уже играет дольше 3 секунд — просто в начало
    if (audio.currentTime > 3 || !history.length) {
      audio.currentTime = 0;
      return;
    }
    const i = history.pop();
    if (i >= 0 && i < tracks.length) {
      loadTrack(i, true, true);
    } else {
      audio.currentTime = 0;
    }
  }

  function removeTrack(i) {
    const [t] = tracks.splice(i, 1);
    if (t && t.objectUrl) URL.revokeObjectURL(t.url);

    const shift = (x) => (x > i ? x - 1 : x);
    history = history.filter((x) => x !== i).map(shift);
    played = new Set([...played].filter((x) => x !== i).map(shift));

    if (i === current) {
      pause();
      audio.removeAttribute('src');
      audio.load();
      current = -1;
      resetNowPlaying();
    } else if (i < current) {
      current--;
    }

    renderPlaylist();
    updateLibCount();
  }

  function clearLibrary() {
    if (!tracks.length) return;
    pause();
    for (const t of tracks) {
      if (t.objectUrl) URL.revokeObjectURL(t.url);
    }
    tracks = [];
    current = -1;
    history = [];
    played = new Set();
    audio.removeAttribute('src');
    audio.load();
    resetNowPlaying();
    renderPlaylist();
    updateLibCount();
    toast('Библиотека очищена');
  }

  /* ---------------------------------------------------------------------
   * Media Session (управление с клавиатуры/шторки системы)
   * ------------------------------------------------------------------- */

  function updateMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const t = tracks[current];
    try {
      navigator.mediaSession.metadata = t && 'MediaMetadata' in window
        ? new MediaMetadata({ title: t.title, artist: 'Audio Equalizer' })
        : null;
    } catch (e) {
      /* ignore */
    }
  }

  if ('mediaSession' in navigator) {
    const ms = navigator.mediaSession;
    const handle = (action, fn) => {
      try { ms.setActionHandler(action, fn); } catch (e) { /* не поддерживается */ }
    };
    handle('play', play);
    handle('pause', pause);
    handle('previoustrack', prevTrack);
    handle('nexttrack', nextTrack);
  }

  /* ---------------------------------------------------------------------
   * Визуализатор
   * ------------------------------------------------------------------- */

  const canvas = $('#viz');
  const cctx = canvas.getContext('2d');
  let rafId = 0;

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawFrame();
  }

  function drawFrame() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    cctx.clearRect(0, 0, w, h);

    const active = graph && !audio.paused;
    let data = null;
    if (active) {
      data = new Uint8Array(graph.analyser.frequencyBinCount);
      graph.analyser.getByteFrequencyData(data);
    }

    const bars = 56;
    const gap = 4;
    const bw = (w - gap * (bars - 1)) / bars;
    const grad = cctx.createLinearGradient(0, h, 0, 0);
    grad.addColorStop(0, '#8b5cf6');
    grad.addColorStop(0.6, '#f472b6');
    grad.addColorStop(1, '#22d3ee');
    cctx.fillStyle = grad;

    const usable = data ? Math.floor(data.length * 0.75) : 0;
    for (let i = 0; i < bars; i++) {
      const idx = Math.floor((i / bars) * usable);
      const v = data ? data[idx] / 255 : 0;
      const bh = Math.max(3, v * (h - 12));
      const x = i * (bw + gap);
      const y = (h - bh) / 2;
      cctx.globalAlpha = data ? 0.45 + v * 0.55 : 0.2;
      cctx.fillRect(x, y, bw, bh);
    }
    cctx.globalAlpha = 1;

    if (active) {
      rafId = requestAnimationFrame(drawFrame);
    } else {
      rafId = 0;
    }
  }

  function startViz() {
    if (!rafId) rafId = requestAnimationFrame(drawFrame);
  }

  window.addEventListener('resize', resizeCanvas);

  /* ---------------------------------------------------------------------
   * События <audio>
   * ------------------------------------------------------------------- */

  let seeking = false;

  audio.addEventListener('play', () => {
    player.classList.add('playing');
    playBtn.setAttribute('aria-label', 'Пауза');
    playBtn.title = 'Пауза (пробел)';
    startViz();
    renderPlaylist();
  });

  audio.addEventListener('pause', () => {
    player.classList.remove('playing');
    playBtn.setAttribute('aria-label', 'Играть');
    playBtn.title = 'Играть (пробел)';
    renderPlaylist();
  });

  audio.addEventListener('loadedmetadata', () => {
    const t = tracks[current];
    if (t && isFinite(audio.duration)) {
      t.duration = audio.duration;
      renderPlaylist();
    }
    seekEl.max = isFinite(audio.duration) ? audio.duration : 0;
    durEl.textContent = isFinite(audio.duration) ? fmtTime(audio.duration) : 'поток';
    paintRange(seekEl);
  });

  audio.addEventListener('durationchange', () => {
    if (isFinite(audio.duration)) {
      seekEl.max = audio.duration;
      durEl.textContent = fmtTime(audio.duration);
      paintRange(seekEl);
    }
  });

  audio.addEventListener('timeupdate', () => {
    curEl.textContent = fmtTime(audio.currentTime);
    if (!seeking) {
      seekEl.value = audio.currentTime;
      paintRange(seekEl);
    }
  });

  audio.addEventListener('ended', () => {
    if (state.repeat === 'one') {
      audio.currentTime = 0;
      play();
      return;
    }
    nextTrack();
  });

  audio.addEventListener('error', () => {
    if (!audio.getAttribute('src')) return;
    const t = tracks[current];
    if (t) {
      t.broken = true;
      renderPlaylist();
      toast(t.remote
        ? 'Поток недоступен: ссылка не аудио или сервер не разрешает доступ'
        : `Не удалось открыть файл «${t.title}»`);
    }
    pause();
  });

  /* ---------------------------------------------------------------------
   * Управление проигрывателем
   * ------------------------------------------------------------------- */

  playBtn.addEventListener('click', togglePlay);
  prevBtn.addEventListener('click', prevTrack);
  nextBtn.addEventListener('click', nextTrack);

  shuffleBtn.addEventListener('click', () => {
    state.shuffle = !state.shuffle;
    played = new Set(current >= 0 ? [current] : []);
    syncPlayerButtons();
    saveState();
    toast(state.shuffle ? 'Перемешивание включено' : 'Перемешивание выключено');
  });

  repeatBtn.addEventListener('click', () => {
    const order = ['off', 'all', 'one'];
    state.repeat = order[(order.indexOf(state.repeat) + 1) % order.length];
    syncPlayerButtons();
    saveState();
    toast({ off: 'Повтор выключен', all: 'Повтор всего плейлиста', one: 'Повтор текущего трека' }[state.repeat]);
  });

  function syncPlayerButtons() {
    shuffleBtn.setAttribute('aria-pressed', String(state.shuffle));
    repeatBtn.dataset.mode = state.repeat;
    repeatBtn.title = { off: 'Повтор: выкл', all: 'Повтор: весь список', one: 'Повтор: один трек' }[state.repeat];
  }

  seekEl.addEventListener('pointerdown', () => { seeking = true; });
  seekEl.addEventListener('pointerup', () => { seeking = false; });
  seekEl.addEventListener('pointercancel', () => { seeking = false; });
  seekEl.addEventListener('input', () => {
    const v = Number(seekEl.value);
    curEl.textContent = fmtTime(v);
    paintRange(seekEl);
    if (current >= 0 && isFinite(audio.duration)) audio.currentTime = v;
  });
  seekEl.addEventListener('change', () => { seeking = false; });

  volumeEl.value = state.volume;
  volumeEl.addEventListener('input', () => {
    state.volume = Number(volumeEl.value);
    paintRange(volumeEl);
    applyParams();
    saveState();
  });

  /* ---------------------------------------------------------------------
   * Добавление музыки: кнопки, drag & drop, ссылка
   * ------------------------------------------------------------------- */

  const openPicker = () => fileInput.click();

  $('#addBtn').addEventListener('click', openPicker);
  dropzone.addEventListener('click', openPicker);
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openPicker();
    }
  });
  fileInput.addEventListener('change', () => {
    addFiles(fileInput.files);
    fileInput.value = '';
  });

  urlForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!urlInput.value.trim()) return;
    if (addRemoteUrl(urlInput.value)) urlInput.value = '';
  });

  $('#clearBtn').addEventListener('click', clearLibrary);

  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');

  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    overlay.classList.add('show');
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) overlay.classList.remove('show');
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    overlay.classList.remove('show');
    addFiles(e.dataTransfer.files);
  });

  /* ---------------------------------------------------------------------
   * Горячие клавиши
   * ------------------------------------------------------------------- */

  document.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const typing = e.target.closest && e.target.closest('input[type="url"], input[type="text"], textarea');
    if (typing) return;
    const interactive = e.target.closest && e.target.closest('button, input, a, .slider');

    if (e.code === 'Space' && !interactive) {
      e.preventDefault();
      togglePlay();
    } else if ((e.code === 'ArrowRight' || e.code === 'ArrowLeft') && !interactive && current >= 0) {
      e.preventDefault();
      const delta = e.code === 'ArrowRight' ? 5 : -5;
      audio.currentTime = clamp(audio.currentTime + delta, 0, isFinite(audio.duration) ? audio.duration : Infinity);
    }
  });

  /* ---------------------------------------------------------------------
   * Эквалайзер UI
   * ------------------------------------------------------------------- */

  const bandsEl = $('#bands');
  const presetsEl = $('#presets');
  const preampEl = $('#preamp');
  const preampOut = $('#preampOut');
  const panEl = $('#pan');
  const panOut = $('#panOut');
  const monoEl = $('#mono');
  const eqEnabledEl = $('#eqEnabled');

  const bandEls = BANDS.map((_, i) => {
    const el = document.createElement('div');
    el.className = 'band';
    el.innerHTML = `
      <output class="db"></output>
      <div class="slider" role="slider" tabindex="0"
           aria-label="Полоса ${LABELS[i]} Гц"
           aria-orientation="vertical"
           aria-valuemin="${-DB_MAX}" aria-valuemax="${DB_MAX}">
        <div class="rail"></div>
        <div class="fill"></div>
        <div class="knob"></div>
      </div>
      <span class="hz">${LABELS[i]}</span>`;
    bandsEl.append(el);

    const slider = el.querySelector('.slider');
    attachDrag(slider, (v) => setBand(i, v));

    slider.addEventListener('dblclick', () => setBand(i, 0));
    slider.addEventListener('keydown', (e) => {
      const step = {
        ArrowUp: 0.5, ArrowRight: 0.5, ArrowDown: -0.5, ArrowLeft: -0.5,
        PageUp: 3, PageDown: -3,
      }[e.key];
      if (step !== undefined) {
        e.preventDefault();
        setBand(i, state.bands[i] + step);
      } else if (e.key === '0' || e.key === 'Home') {
        e.preventDefault();
        setBand(i, 0);
      }
    });
    return el;
  });

  // Перетаскивание ползунка мышью и пальцем
  function attachDrag(el, onChange) {
    const valueAt = (e) => {
      const r = el.getBoundingClientRect();
      const p = 1 - clamp((e.clientY - r.top) / r.height, 0, 1);
      return snap(-DB_MAX + p * 2 * DB_MAX);
    };
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      el.setPointerCapture(e.pointerId);
      el.classList.add('drag');
      el.focus({ preventScroll: true });
      onChange(valueAt(e));
    });
    el.addEventListener('pointermove', (e) => {
      if (el.hasPointerCapture(e.pointerId)) onChange(valueAt(e));
    });
    const end = (e) => {
      el.classList.remove('drag');
      if (el.hasPointerCapture && el.hasPointerCapture(e.pointerId)) {
        el.releasePointerCapture(e.pointerId);
      }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  function setBand(i, value) {
    const v = clamp(snap(value), -DB_MAX, DB_MAX);
    if (state.bands[i] === v) return;
    state.bands[i] = v;
    updateBandUI(i);
    renderPresets();
    applyParams();
    saveState();
  }

  function updateBandUI(i) {
    const el = bandEls[i];
    const v = state.bands[i];
    const p = (v + DB_MAX) / (2 * DB_MAX); // 0 = низ, 1 = верх
    const slider = el.querySelector('.slider');
    const fill = el.querySelector('.fill');
    const knob = el.querySelector('.knob');

    fill.style.bottom = `${Math.min(p, 0.5) * 100}%`;
    fill.style.height = `${Math.abs(p - 0.5) * 100}%`;
    knob.style.bottom = `calc(${p * 100}% - 9px)`;

    slider.classList.toggle('boost', v > 0);
    slider.classList.toggle('cut', v < 0);
    el.classList.toggle('zero', v === 0);
    el.querySelector('.db').textContent = v === 0 ? '0' : fmtDb(v);
    slider.setAttribute('aria-valuenow', String(v));
    slider.setAttribute('aria-valuetext', `${fmtDb(v)} дБ`);
  }

  function renderPresets() {
    presetsEl.textContent = '';
    const active = presetName();
    for (const name of Object.keys(PRESETS)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (name === active ? ' active' : '');
      b.textContent = name;
      b.setAttribute('aria-pressed', String(name === active));
      b.addEventListener('click', () => {
        state.bands = [...PRESETS[name]];
        state.bands.forEach((_, i) => updateBandUI(i));
        renderPresets();
        applyParams();
        saveState();
      });
      presetsEl.append(b);
    }
    if (!active) {
      const c = document.createElement('span');
      c.className = 'chip custom active';
      c.textContent = 'Свой';
      presetsEl.append(c);
    }
  }

  function paintRange(input) {
    const min = Number(input.min);
    const max = Number(input.max);
    const pct = max > min ? ((Number(input.value) - min) / (max - min)) * 100 : 0;
    input.style.setProperty('--fill', `${clamp(pct, 0, 100)}%`);
  }

  function panLabel(v) {
    if (Math.abs(v) < 0.025) return 'Центр';
    const pct = Math.round(Math.abs(v) * 100);
    return v < 0 ? `Л ${pct}%` : `П ${pct}%`;
  }

  preampEl.addEventListener('input', () => {
    state.preamp = Number(preampEl.value);
    preampOut.textContent = `${fmtDb(state.preamp)} dB`;
    paintRange(preampEl);
    applyParams();
    saveState();
  });

  panEl.addEventListener('input', () => {
    state.pan = Number(panEl.value);
    panOut.textContent = panLabel(state.pan);
    paintRange(panEl);
    applyParams();
    saveState();
  });

  monoEl.addEventListener('change', () => {
    state.mono = monoEl.checked;
    applyParams();
    saveState();
  });

  eqEnabledEl.addEventListener('change', () => {
    state.enabled = eqEnabledEl.checked;
    eqCard.classList.toggle('off', !state.enabled);
    routeSource();
    saveState();
  });

  $('#resetBtn').addEventListener('click', () => {
    state.bands = [...DEFAULTS.bands];
    state.preamp = 0;
    state.pan = 0;
    syncEqUI();
    applyParams();
    saveState();
    toast('Эквалайзер сброшен');
  });

  function syncEqUI() {
    state.bands.forEach((_, i) => updateBandUI(i));
    renderPresets();
    preampEl.value = state.preamp;
    preampOut.textContent = `${fmtDb(state.preamp)} dB`;
    paintRange(preampEl);
    panEl.value = state.pan;
    panOut.textContent = panLabel(state.pan);
    paintRange(panEl);
    monoEl.checked = state.mono;
    eqEnabledEl.checked = state.enabled;
    eqCard.classList.toggle('off', !state.enabled);
  }

  /* ---------------------------------------------------------------------
   * Уведомления
   * ------------------------------------------------------------------- */

  let toastTimer = 0;
  function toast(message) {
    toastEl.textContent = message;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3000);
  }

  /* ---------------------------------------------------------------------
   * Старт
   * ------------------------------------------------------------------- */

  syncEqUI();
  syncPlayerButtons();
  paintRange(volumeEl);
  paintRange(seekEl);
  renderPlaylist();
  updateLibCount();
  resizeCanvas();
})();
