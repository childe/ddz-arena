import { type FormEvent, useState } from 'react';
import { api, errorText } from '../api.ts';
import { setGuest, useGuest } from '../guest.ts';
import { toast } from './Toast.tsx';

const NAME_RE = /^[\p{L}\p{N}_-]{1,24}$/u;

/** Form to create a guest identity (token for 真人下场 / 新建房间). */
export function GuestForm({ compact }: { compact?: boolean }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!NAME_RE.test(n)) {
      toast('名字为 1–24 个字符：字母、数字、中文、-、_');
      return;
    }
    setBusy(true);
    try {
      const acc = await api.createGuest(n);
      setGuest(acc);
      toast(`欢迎，${acc.name}`, 'info');
    } catch (err) {
      toast(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className={`guest-form${compact ? ' compact' : ''}`} onSubmit={submit}>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="输入昵称" maxLength={24} aria-label="昵称" />
      <button className="btn btn-primary" disabled={busy}>
        {busy ? '创建中…' : '创建游客身份'}
      </button>
    </form>
  );
}

export function GuestBadge() {
  const guest = useGuest();
  if (!guest) return null;
  return (
    <span className="guest-badge">
      <span title={guest.bot_id}>{guest.name}</span>
      <button
        className="link-btn"
        onClick={() => {
          if (confirm('退出游客身份？token 会从本机删除，之后无法再用这个身份操作。')) setGuest(null);
        }}
      >
        退出
      </button>
    </span>
  );
}
