import { useEffect, useState } from 'react';

interface ToastItem {
  id: number;
  text: string;
  kind: 'error' | 'info';
}

let nextId = 1;
const listeners = new Set<(t: ToastItem) => void>();

export function toast(text: string, kind: 'error' | 'info' = 'error'): void {
  const t = { id: nextId++, text, kind };
  listeners.forEach((l) => l(t));
}

export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);
  useEffect(() => {
    const on = (t: ToastItem) => {
      setItems((xs) => [...xs.slice(-3), t]);
      setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== t.id)), 3500);
    };
    listeners.add(on);
    return () => {
      listeners.delete(on);
    };
  }, []);
  return (
    <div className="toaster" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} onClick={() => setItems((xs) => xs.filter((x) => x.id !== t.id))}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
