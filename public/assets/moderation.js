/* =========================================================================
   НЕФТЬ · Панель модерации — клиентская логика
   ========================================================================= */

(() => {
  'use strict';

  const MAX_CHARS = 600;
  const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

  // Секретный ключ берём из адресной строки: /moderation?key=...
  const key = new URLSearchParams(window.location.search).get('key') || '';
  const API = '/api/moderation/stories';

  const list = document.getElementById('mod-list');
  const template = document.getElementById('mod-card-template');
  const errorBox = document.getElementById('mod-error');
  const summary = document.getElementById('mod-summary');
  const emptyState = document.getElementById('mod-empty');

  let stories = [];
  let filter = 'all';

  /* ------------------------------- API --------------------------------- */

  async function api(url, options = {}) {
    const response = await fetch(url, {
      headers: { 'Content-Type': 'application/json', 'X-Moderation-Key': key },
      ...options,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Ошибка запроса');
    return data;
  }

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
  }
  function clearError() { errorBox.hidden = true; }

  function formatDate(iso) {
    try {
      return new Date(iso).toLocaleString('ru-RU', {
        day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
      });
    } catch {
      return '';
    }
  }

  /* ----------------------------- отрисовка ------------------------------ */

  function visibleStories() {
    if (filter === 'pending') return stories.filter((s) => !s.published);
    if (filter === 'published') return stories.filter((s) => s.published);
    return stories;
  }

  function render() {
    list.innerHTML = '';
    const items = visibleStories();

    summary.textContent = stories.length
      ? `Всего: ${stories.length} · на модерации: ${stories.filter((s) => !s.published).length} · опубликовано: ${stories.filter((s) => s.published).length}`
      : 'Историй пока нет.';

    emptyState.hidden = items.length > 0;

    for (const story of items) list.appendChild(buildCard(story));
  }

  function buildCard(story) {
    const node = template.content.firstElementChild.cloneNode(true);
    node.dataset.id = story.id;
    node.classList.toggle('is-published', story.published);

    // --- фото и текст ---
    const thumb = node.querySelector('.mod-thumb');
    const img = node.querySelector('.mod-thumb img');
    const badge = node.querySelector('.badge');
    const text = node.querySelector('.mod-text');
    const date = node.querySelector('.mod-date');

    function paintThumb(photoUrl) {
      if (photoUrl) {
        img.src = photoUrl;
        img.alt = 'Фото из истории';
        thumb.classList.add('has-photo');
      } else {
        img.removeAttribute('src');
        thumb.classList.remove('has-photo');
      }
    }

    function paintBadge(published) {
      badge.textContent = published ? 'Опубликовано' : 'На модерации';
      badge.className = 'badge ' + (published ? 'published' : 'pending');
      node.classList.toggle('is-published', published);
      node.querySelector('.publish-toggle').checked = published;
    }

    paintThumb(story.photo);
    paintBadge(story.published);
    text.textContent = story.text;
    date.textContent = formatDate(story.createdAt);

    // --- переключатель публикации ---
    const toggle = node.querySelector('.publish-toggle');
    toggle.addEventListener('change', async () => {
      const desired = toggle.checked;
      toggle.disabled = true;
      clearError();
      try {
        const data = await api(`${API}/${story.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ published: desired }),
        });
        updateLocal(data.story);
        paintBadge(data.story.published);
        render();
      } catch (error) {
        toggle.checked = !desired;
        showError(error.message);
      } finally {
        toggle.disabled = false;
      }
    });

    // --- редактирование ---
    const editForm = node.querySelector('.mod-edit');
    const editText = node.querySelector('.edit-text');
    const editCounter = node.querySelector('.edit-counter');
    const meterFill = node.querySelector('.meter-fill');
    const meter = node.querySelector('.meter');
    const editPhoto = node.querySelector('.edit-photo');
    const editPhotoName = node.querySelector('.edit-photo-name');
    const removePhotoBtn = node.querySelector('.remove-photo-btn');
    const editError = node.querySelector('.edit-error');

    let newPhoto = '';        // '' — не менять, dataURL — заменить
    let removePhoto = false;  // true — удалить текущее фото
    let currentPhoto = story.photo;

    function updateCounter() {
      const length = editText.value.length;
      editCounter.textContent = `${length} / ${MAX_CHARS}`;
      meterFill.style.width = Math.min(100, (length / MAX_CHARS) * 100) + '%';
      meter.classList.toggle('is-limit', length >= MAX_CHARS);
    }

    function setEditError(message) {
      editError.textContent = message;
      editError.hidden = !message;
    }

    node.querySelector('.edit-btn').addEventListener('click', () => {
      const opening = editForm.hidden;
      if (!opening) {
        editForm.hidden = true;
        return;
      }
      // сбрасываем черновик к актуальному состоянию
      editText.value = story.text;
      newPhoto = '';
      removePhoto = false;
      currentPhoto = story.photo;
      editPhoto.value = '';
      editPhotoName.textContent = story.photo ? 'Текущее фото сохранено' : 'Фото не выбрано';
      removePhotoBtn.disabled = !story.photo;
      setEditError('');
      updateCounter();
      editForm.hidden = false;
      editText.focus();
    });

    node.querySelector('.cancel-btn').addEventListener('click', () => { editForm.hidden = true; });
    editText.addEventListener('input', () => { updateCounter(); setEditError(''); });

    editPhoto.addEventListener('change', () => {
      const file = editPhoto.files && editPhoto.files[0];
      if (!file) return;
      if (!file.type.startsWith('image/')) return setEditError('Можно приложить только изображение');
      if (file.size > MAX_PHOTO_BYTES) return setEditError('Фотография слишком большая: максимум 5 МБ');

      const reader = new FileReader();
      reader.onload = () => {
        newPhoto = reader.result;
        removePhoto = false;
        removePhotoBtn.disabled = false;
        editPhotoName.textContent = 'Новое фото: ' + file.name;
        setEditError('');
      };
      reader.readAsDataURL(file);
    });

    removePhotoBtn.addEventListener('click', () => {
      removePhoto = true;
      newPhoto = '';
      editPhoto.value = '';
      editPhotoName.textContent = 'Фото будет удалено';
      setEditError('');
    });

    editForm.addEventListener('submit', async (event) => {
      event.preventDefault();

      const value = editText.value.trim();
      if (!value) return setEditError('История не может быть пустой');
      if (editText.value.length > MAX_CHARS) return setEditError(`Максимум ${MAX_CHARS} символов`);

      const payload = { text: value };
      if (newPhoto) payload.photo = newPhoto;          // заменить
      else if (removePhoto) payload.photo = null;      // удалить

      const saveBtn = node.querySelector('.save-btn');
      saveBtn.disabled = true;
      saveBtn.textContent = 'Сохраняем…';
      setEditError('');

      try {
        const data = await api(`${API}/${story.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
        updateLocal(data.story);
        render();
      } catch (error) {
        setEditError(error.message);
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Сохранить';
      }
    });

    return node;
  }

  function updateLocal(updated) {
    const index = stories.findIndex((s) => s.id === updated.id);
    if (index !== -1) stories[index] = updated;
  }

  /* ------------------------------ загрузка ------------------------------ */

  async function load() {
    clearError();
    summary.textContent = 'Загрузка…';
    try {
      const data = await api(API);
      stories = data.stories || [];
      render();
    } catch (error) {
      summary.textContent = 'Не удалось загрузить данные';
      showError(
        error.message === 'Страница не найдена' || !key
          ? 'Нет доступа. Откройте страницу по полной ссылке с ключом: /moderation?key=…'
          : error.message
      );
      emptyState.hidden = true;
    }
  }

  document.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      filter = chip.dataset.filter;
      document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('is-active', c === chip));
      render();
    });
  });

  document.getElementById('refresh-btn').addEventListener('click', load);

  load();
})();
