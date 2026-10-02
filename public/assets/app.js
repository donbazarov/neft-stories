/* =========================================================================
   НЕФТЬ · Истории гостей — клиентская логика главной страницы
   ========================================================================= */

(() => {
  'use strict';

  const API_PUBLIC = '/api/stories';
  const MAX_CHARS = 600;
  const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
  const AUTOPLAY_MS = 7000;

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* =====================================================================
     1. Фон — разноцветные кривые Безье «радужные масляные разводы»
     ===================================================================== */

  const canvas = document.getElementById('oil-canvas');
  const ctx = canvas.getContext('2d');

  // Каждый слой — это «мазок масла» со своей амплитудой, скоростью и оттенком.
  const layers = [
    { base: 0.16, amp: 90, sway: 60, freq: 1.1, speed: 0.10, hue: 205, hueSpeed: 6, thickness: 120, alpha: 0.10, phase: 0.0 },
    { base: 0.32, amp: 70, sway: 84, freq: 0.8, speed: 0.14, hue: 285, hueSpeed: 8, thickness: 150, alpha: 0.09, phase: 1.7 },
    { base: 0.48, amp: 110, sway: 50, freq: 1.4, speed: 0.09, hue: 160, hueSpeed: 5, thickness: 110, alpha: 0.08, phase: 3.1 },
    { base: 0.64, amp: 80, sway: 70, freq: 1.0, speed: 0.12, hue: 330, hueSpeed: 7, thickness: 135, alpha: 0.09, phase: 4.6 },
    { base: 0.80, amp: 95, sway: 55, freq: 1.2, speed: 0.11, hue: 45, hueSpeed: 4, thickness: 120, alpha: 0.08, phase: 6.0 },
  ];

  let width = 0;
  let height = 0;

  function resizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (reduceMotion) drawBackground(0);
  }

  function wave(t, layer, k) {
    const p = k + layer.phase;
    return (
      layer.amp * Math.sin(t * layer.speed + p * layer.freq) +
      layer.sway * Math.cos(t * layer.speed * 0.63 + p * layer.freq * 0.5)
    );
  }

  /** Рисует один «мазок» из последовательных кубических кривых Безье. */
  function strokeRibbon(t, layer) {
    const segments = 4;
    const span = width + 160;
    const step = span / segments;
    const yBase = height * layer.base;
    const hue = (layer.hue + t * layer.hueSpeed) % 360;

    ctx.beginPath();
    ctx.moveTo(-80, yBase + wave(t, layer, 0));
    for (let i = 0; i < segments; i++) {
      const x0 = -80 + step * i;
      ctx.bezierCurveTo(
        x0 + step * 0.34, yBase + wave(t, layer, i + 0.34),
        x0 + step * 0.68, yBase + wave(t, layer, i + 0.68),
        x0 + step, yBase + wave(t, layer, i + 1)
      );
    }

    ctx.strokeStyle = `hsla(${hue}, 88%, 62%, ${layer.alpha})`;
    ctx.lineWidth = layer.thickness;
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  function drawBackground(t) {
    ctx.clearRect(0, 0, width, height);
    ctx.globalCompositeOperation = 'lighter';

    for (const layer of layers) {
      // Три близких по цвету прохода дают эффект радужного перелива.
      strokeRibbon(t, layer);
      strokeRibbon(t * 1.04, { ...layer, hue: layer.hue + 26, thickness: layer.thickness * 0.55, alpha: layer.alpha * 0.7 });
      strokeRibbon(t * 0.96, { ...layer, hue: layer.hue - 24, thickness: layer.thickness * 0.35, alpha: layer.alpha * 0.6 });
    }

    ctx.globalCompositeOperation = 'source-over';
  }

  const clockStart = performance.now();
  let lastFrame = 0;
  let rafId = null;

  function loop(now) {
    // Ограничиваем частоту ~30 к/с — плавно и не грузит слабые устройства.
    if (now - lastFrame >= 33) {
      lastFrame = now;
      drawBackground((now - clockStart) / 1000);
    }
    rafId = requestAnimationFrame(loop);
  }

  function startBackground() {
    if (reduceMotion || rafId !== null) return;
    rafId = requestAnimationFrame(loop);
  }

  function stopBackground() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  window.addEventListener('resize', resizeCanvas);
  document.addEventListener('visibilitychange', () => {
    document.hidden ? stopBackground() : startBackground();
  });

  resizeCanvas();
  startBackground();

  /* =====================================================================
     2. Утилиты
     ===================================================================== */

  async function api(url, options = {}) {
    const response = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Что-то пошло не так');
    return data;
  }

  function formatDate(iso) {
    try {
      return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
    } catch {
      return '';
    }
  }

  function show(element) { element.hidden = false; }
  function hide(element) { element.hidden = true; }

  /* =====================================================================
     3. Карусель опубликованных историй
     ===================================================================== */

  const carousel = {
    viewport: document.getElementById('carousel-viewport'),
    track: document.getElementById('carousel-track'),
    template: document.getElementById('slide-template'),
    empty: document.getElementById('carousel-empty'),
    controls: document.getElementById('carousel-controls'),
    progress: document.getElementById('progress'),
    progressBar: document.getElementById('progress-bar'),
    dots: document.getElementById('dots'),
    stories: [],
    index: 0,
    timer: null,
  };

  function renderCarousel(stories) {
    carousel.stories = stories;
    carousel.track.innerHTML = '';
    carousel.dots.innerHTML = '';

    if (!stories.length) {
      show(carousel.empty);
      hide(carousel.controls);
      hide(carousel.progress);
      return;
    }

    hide(carousel.empty);
    show(carousel.controls);
    show(carousel.progress);

    stories.forEach((story, i) => {
      const node = carousel.template.content.firstElementChild.cloneNode(true);
      node.dataset.index = String(i);

      const text = node.querySelector('.slide-text');
      text.textContent = story.text;

      const date = node.querySelector('.slide-date');
      date.textContent = formatDate(story.createdAt);

      if (story.photo) {
        const img = node.querySelector('.slide-photo img');
        img.src = story.photo;
        img.alt = 'Фотография из истории гостя НЕФТИ';
      } else {
        node.classList.add('no-photo');
      }

      carousel.track.appendChild(node);

      const dot = document.createElement('button');
      dot.className = 'dot-btn';
      dot.type = 'button';
      dot.setAttribute('role', 'tab');
      dot.setAttribute('aria-label', `История ${i + 1}`);
      dot.addEventListener('click', () => goTo(i, true));
      carousel.dots.appendChild(dot);
    });

    carousel.index = 0;
    updateSlides();
    scheduleAutoplay();
  }

  function updateSlides() {
    const slides = carousel.track.children;
    for (let i = 0; i < slides.length; i++) {
      const slide = slides[i];
      slide.classList.toggle('is-active', i === carousel.index);
      slide.classList.toggle('is-prev', i < carousel.index);
      slide.classList.toggle('is-next', i > carousel.index);
      slide.setAttribute('aria-hidden', i === carousel.index ? 'false' : 'true');
    }
    [...carousel.dots.children].forEach((dot, i) => {
      dot.classList.toggle('is-active', i === carousel.index);
      dot.setAttribute('aria-selected', i === carousel.index ? 'true' : 'false');
    });
  }

  function goTo(index, manual = false) {
    const total = carousel.stories.length;
    if (!total) return;
    carousel.index = (index + total) % total;
    updateSlides();
    restartProgress();
    if (manual) scheduleAutoplay();

    if (carousel.stories[carousel.index].photo) {
      const img = carousel.track.children[carousel.index].querySelector('img');
      if (img && !img.complete) img.decode?.().catch(() => {});
    }
  }

  function next() { goTo(carousel.index + 1); }
  function prev() { goTo(carousel.index - 1); }

  function scheduleAutoplay() {
    clearTimeout(carousel.timer);
    restartProgress();
    if (reduceMotion || carousel.stories.length < 2) {
      carousel.progressBar.style.width = carousel.stories.length ? '100%' : '0';
      return;
    }
    carousel.timer = setTimeout(() => {
      next();
      scheduleAutoplay();
    }, AUTOPLAY_MS);
  }

  function restartProgress() {
    const bar = carousel.progressBar;
    if (!carousel.stories.length || reduceMotion || carousel.stories.length < 2) return;
    bar.style.transition = 'none';
    bar.style.width = '0%';
    void bar.offsetWidth;                       // принудительный reflow
    bar.style.transition = `width ${AUTOPLAY_MS}ms linear`;
    bar.style.width = '100%';
  }

  function pauseAutoplay() {
    clearTimeout(carousel.timer);
    carousel.timer = null;
    carousel.progressBar.style.transition = 'none';
    carousel.progressBar.style.width = '0%';
  }

  document.getElementById('next-btn').addEventListener('click', () => goTo(carousel.index + 1, true));
  document.getElementById('prev-btn').addEventListener('click', () => goTo(carousel.index - 1, true));

  carousel.viewport.addEventListener('mouseenter', pauseAutoplay);
  carousel.viewport.addEventListener('mouseleave', () => scheduleAutoplay());
  carousel.viewport.addEventListener('focusin', pauseAutoplay);
  carousel.viewport.addEventListener('focusout', () => scheduleAutoplay());

  // Свайп на мобильных
  let touchStartX = null;
  carousel.viewport.addEventListener('touchstart', (e) => {
    touchStartX = e.changedTouches[0].clientX;
    pauseAutoplay();
  }, { passive: true });
  carousel.viewport.addEventListener('touchend', (e) => {
    if (touchStartX === null) return;
    const delta = e.changedTouches[0].clientX - touchStartX;
    if (Math.abs(delta) > 45) goTo(carousel.index + (delta < 0 ? 1 : -1), true);
    else scheduleAutoplay();
    touchStartX = null;
  }, { passive: true });

  // Стрелки клавиатуры
  document.addEventListener('keydown', (e) => {
    if (document.getElementById('editor-modal').hidden === false) return;
    if (e.key === 'ArrowRight') goTo(carousel.index + 1, true);
    if (e.key === 'ArrowLeft') goTo(carousel.index - 1, true);
  });

  /* =====================================================================
     4. Редактор истории
     ===================================================================== */

  const modal = document.getElementById('editor-modal');
  const editorView = document.getElementById('editor-view');
  const thanksView = document.getElementById('thanks-view');
  const textarea = document.getElementById('story-text');
  const counter = document.getElementById('counter');
  const meter = document.querySelector('.meter');
  const meterFill = document.getElementById('meter-fill');
  const photoInput = document.getElementById('photo-input');
  const photoName = document.getElementById('photo-name');
  const photoPreview = document.getElementById('photo-preview');
  const photoPreviewImg = document.getElementById('photo-preview-img');
  const formError = document.getElementById('form-error');
  const submitBtn = document.getElementById('submit-btn');

  let photoDataUrl = null;
  let lastFocused = null;

  function updateMeter() {
    const length = textarea.value.length;
    counter.textContent = `${length} / ${MAX_CHARS}`;
    const percent = Math.min(100, (length / MAX_CHARS) * 100);
    meterFill.style.width = percent + '%';
    meter.classList.toggle('is-warn', length > MAX_CHARS * 0.8 && length < MAX_CHARS);
    meter.classList.toggle('is-limit', length >= MAX_CHARS);
  }

  function clearError() { hide(formError); formError.textContent = ''; }
  function setError(message) { formError.textContent = message; show(formError); }

  function resetForm() {
    textarea.value = '';
    photoDataUrl = null;
    photoInput.value = '';
    photoName.textContent = 'Фотография не выбрана';
    photoPreviewImg.removeAttribute('src');
    hide(photoPreview);
    clearError();
    submitBtn.disabled = false;
    submitBtn.textContent = 'Отправить историю';
    updateMeter();
  }

  function openModal() {
    lastFocused = document.activeElement;
    resetForm();
    show(editorView);
    hide(thanksView);
    show(modal);
    document.body.style.overflow = 'hidden';
    setTimeout(() => textarea.focus(), 60);
    pauseAutoplay();
  }

  function closeModal() {
    hide(modal);
    document.body.style.overflow = '';
    if (lastFocused instanceof HTMLElement) lastFocused.focus();
    scheduleAutoplay();
  }

  document.getElementById('share-btn').addEventListener('click', openModal);
  document.getElementById('header-share').addEventListener('click', openModal);
  document.getElementById('editor-close').addEventListener('click', closeModal);
  document.getElementById('thanks-done').addEventListener('click', closeModal);
  modal.querySelector('[data-close]').addEventListener('click', closeModal);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) closeModal();
  });

  textarea.addEventListener('input', () => {
    updateMeter();
    if (textarea.value.trim()) clearError();
  });

  // Фото: только одно изображение
  photoInput.addEventListener('change', () => {
    const file = photoInput.files && photoInput.files[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      setError('Можно приложить только изображение');
      photoInput.value = '';
      return;
    }
    if (file.size > MAX_PHOTO_BYTES) {
      setError('Фотография слишком большая: максимум 5 МБ');
      photoInput.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      photoDataUrl = reader.result;
      photoPreviewImg.src = photoDataUrl;
      photoName.textContent = file.name;
      show(photoPreview);
      clearError();
    };
    reader.readAsDataURL(file);
  });

  document.getElementById('photo-remove').addEventListener('click', () => {
    photoDataUrl = null;
    photoInput.value = '';
    photoName.textContent = 'Фотография не выбрана';
    photoPreviewImg.removeAttribute('src');
    hide(photoPreview);
  });

  submitBtn.addEventListener('click', async () => {
    const text = textarea.value.trim();

    if (!text) {
      setError('История не может быть пустой');
      textarea.focus();
      return;
    }
    if (textarea.value.length > MAX_CHARS) {
      setError(`Слишком длинная история: максимум ${MAX_CHARS} символов`);
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Отправляем…';
    clearError();

    try {
      await api(API_PUBLIC, {
        method: 'POST',
        body: JSON.stringify({ text, photo: photoDataUrl }),
      });
      hide(editorView);
      show(thanksView);              // экран с купоном
    } catch (error) {
      setError(error.message);
      submitBtn.disabled = false;
      submitBtn.textContent = 'Отправить историю';
    }
  });

  /* =====================================================================
     5. Старт
     ===================================================================== */

  document.getElementById('year').textContent = String(new Date().getFullYear());
  updateMeter();

  api(API_PUBLIC)
    .then((data) => renderCarousel(data.stories || []))
    .catch(() => {
      show(carousel.empty);
      hide(carousel.controls);
      hide(carousel.progress);
      carousel.empty.querySelector('p').textContent = 'Не удалось загрузить истории. Обновите страницу.';
    });
})();
