export function safeText(value, max = 42) {
  return String(value || '').replace(/[<>"'&]/g, '').slice(0, max).trim();
}

export function cleanEnglishPrompt(value) {
  if (typeof value !== 'string') return '';
  const text = safeText(value, 900).normalize('NFKC').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[–—−]/g, '-').replace(/…/g, '...');
  return /^[\x00-\x7F]+$/.test(text) && /[A-Za-z]{3,}/.test(text) ? text : '';
}
