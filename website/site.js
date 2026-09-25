const toggle = document.querySelector('.theme-toggle');
let saved;
try {
  saved = localStorage.getItem('folio-site-theme');
} catch {
  /* Theme works without storage. */
}
const setTheme = (theme) => {
  document.documentElement.dataset.theme = theme;
  if (toggle) {
    toggle.textContent = theme === 'dark' ? 'Light' : 'Dark';
    toggle.setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`);
  }
};
setTheme(saved === 'light' ? 'light' : 'dark');
toggle?.addEventListener('click', () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  setTheme(theme);
  try {
    localStorage.setItem('folio-site-theme', theme);
  } catch {
    /* Optional preference. */
  }
});
