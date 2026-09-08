'use strict';

// Apply before styles load to avoid a bright flash on nighttime visits.
(() => {
  const key = 'kalshi-theme';
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  const valid = (value) => ['dark', 'light', 'system'].includes(value);
  let preference = 'dark';
  try {
    const saved = localStorage.getItem(key);
    if (valid(saved)) preference = saved;
  } catch (_) { /* The theme still works when storage is unavailable. */ }

  function apply() {
    const theme = preference === 'system' ? (system.matches ? 'dark' : 'light') : preference;
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  }
  apply();
  system.addEventListener('change', apply);
  document.addEventListener('DOMContentLoaded', () => {
    const select = document.getElementById('themeSelect');
    select.value = preference;
    select.addEventListener('change', () => {
      preference = select.value;
      apply();
      try { localStorage.setItem(key, preference); } catch (_) { /* Optional persistence. */ }
    });
    window.addEventListener('storage', (event) => {
      if (event.key !== key && event.key !== null) return;
      preference = valid(event.newValue) ? event.newValue : 'dark';
      select.value = preference;
      apply();
    });
  });
})();
