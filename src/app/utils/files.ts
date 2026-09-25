export { extractJson } from '../../core/util/extractJson';

export function downloadText(filename: string, content: string, mime = 'application/octet-stream'): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function pickTextFile(accept = '.json,application/json'): Promise<{ name: string; content: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      resolve({ name: file.name, content: await file.text() });
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

export function safeFilename(name: string, ext: string): string {
  const base = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9-_ ]+/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase();
  return `${base || 'diagrama-c4'}.${ext}`;
}

export function relativeTime(ts: number | null): string {
  if (!ts) return 'Sin guardar';
  const diff = Math.max(0, Date.now() - ts);
  const s = Math.round(diff / 1000);
  if (s < 10) return 'Guardado ahora mismo';
  if (s < 60) return `Guardado hace ${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `Guardado hace ${m} min`;
  const h = Math.round(m / 60);
  return `Guardado hace ${h} h`;
}
