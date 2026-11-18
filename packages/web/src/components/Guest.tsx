import { type FormEvent, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { type Account, ApiError, api, errorText, forgetKnown, loadKnown } from '../api.ts';
import { setGuest, useGuest } from '../guest.ts';
import { toast } from './Toast.tsx';

const NAME_RE = /^[\p{L}\p{N}_-]{1,24}$/u;

// The guest just created in this page load; TokenNotice shows its token until dismissed.
let fresh: Account | null = null;
const freshListeners = new Set<() => void>();
function setFresh(acc: Account | null) {
  fresh = acc;
  freshListeners.forEach((l) => l());
}

/** Check a token with GET /me and make it the current identity. */
async function signIn(token: string): Promise<Account> {
  const me = await api.me(token);
  const acc: Account = { bot_id: me.bot_id, name: me.name, kind: me.kind, token };
  setGuest(acc);
  toast(`欢迎回来，${acc.name}`, 'info');
  return acc;
}

/** Identity picker: identities used in this browser, a new guest, or sign in with a token. */
export function GuestForm({ compact }: { compact?: boolean }) {
  const [name, setName] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [known, setKnown] = useState(loadKnown);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const create = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!NAME_RE.test(n)) {
      toast('名字为 1–24 个字符：字母、数字、中文、-、_');
      return;
    }
    run(async () => {
      try {
        const acc = await api.createGuest(n);
        setGuest(acc);
        setFresh(acc);
      } catch (err) {
        toast(err instanceof ApiError && err.code === 'NAME_TAKEN' ? `「${n}」已被占用；如果是你的身份，请用 token 登录` : errorText(err));
      }
    });
  };

  const loginToken = (e: FormEvent) => {
    e.preventDefault();
    const t = token.trim();
    if (!t) return;
    run(async () => {
      try {
        await signIn(t);
      } catch (err) {
        toast(err instanceof ApiError && err.status === 401 ? 'token 无效' : errorText(err));
      }
    });
  };

  const switchTo = (k: Account) =>
    run(async () => {
      try {
        await signIn(k.token);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          forgetKnown(k.bot_id);
          setKnown(loadKnown());
          toast(`「${k.name}」已失效，已从列表移除`);
        } else toast(errorText(err));
      }
    });

  const forget = (k: Account) => {
    if (!confirm(`从本机忘掉「${k.name}」？如果没有另外保存它的 token，就再也用不了这个身份。`)) return;
    forgetKnown(k.bot_id);
    setKnown(loadKnown());
  };

  return (
    <div className={`guest-form${compact ? ' compact' : ''}`}>
      {known.length > 0 && (
        <div className="guest-known">
          <span className="muted">用过的身份：</span>
          {known.map((k) => (
            <span key={k.bot_id} className="guest-chip">
              <button type="button" className="btn btn-small" disabled={busy} onClick={() => switchTo(k)} title={`切换到 ${k.name}`}>
                {k.name}
              </button>
              <button type="button" className="link-btn guest-forget" onClick={() => forget(k)} title="从本机忘掉" aria-label={`忘掉 ${k.name}`}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <form className="guest-row" onSubmit={create}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="输入昵称" maxLength={24} aria-label="昵称" />
        <button className="btn btn-primary" disabled={busy}>
          {busy ? '请稍候…' : '创建游客身份'}
        </button>
      </form>
      <details className="guest-token-login">
        <summary>用 token 登录</summary>
        <form className="guest-row" onSubmit={loginToken}>
          <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="ddz_…" aria-label="token" autoComplete="off" spellCheck={false} />
          <button className="btn" disabled={busy}>
            登录
          </button>
        </form>
      </details>
    </div>
  );
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Shown once after a guest is created: the token is the only way back to this identity. */
export function TokenNotice() {
  const acc = useSyncExternalStore(
    (cb) => {
      freshListeners.add(cb);
      return () => {
        freshListeners.delete(cb);
      };
    },
    () => fresh,
  );
  const ref = useRef<HTMLDialogElement>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const d = ref.current;
    if (acc && d && !d.open) {
      setCopied(false);
      d.showModal();
    }
  }, [acc]);
  if (!acc) return null;
  return (
    <dialog ref={ref} className="token-notice" onClose={() => setFresh(null)} aria-labelledby="token-notice-title">
      <h3 id="token-notice-title">欢迎，{acc.name}！请保存你的 token</h3>
      <p>token 相当于这个身份的密码，以后可以用它登录。</p>
      <p>
        换了浏览器、换了手机，或者清空了浏览器缓存后，本机会忘掉这个身份。这时在「用 token 登录」里输入 token，就能登录回原来的身份。
      </p>
      <p className="muted">不要把 token 发给别人：拿到它的人可以用你的身份打牌。</p>
      <input
        className="token-notice-value"
        readOnly
        value={acc.token}
        aria-label="token"
        onFocus={(e) => e.currentTarget.select()}
      />
      <div className="token-notice-actions">
        <button
          type="button"
          className="btn"
          onClick={async () => {
            if (await copyText(acc.token)) setCopied(true);
            else toast('复制失败，请长按上面的 token 手动复制');
          }}
        >
          {copied ? '已复制' : '复制 token'}
        </button>
        <button type="button" className="btn btn-primary" onClick={() => ref.current?.close()}>
          我已保存
        </button>
      </div>
      <p className="muted token-notice-later">之后也可以点右上角「复制 token」再次复制。</p>
    </dialog>
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
        title="token 是这个身份的凭证，换浏览器时用它登录"
        onClick={async () => {
          if (await copyText(guest.token)) toast('已复制 token，请保存到安全的地方', 'info');
          else prompt('复制并保存这个 token：', guest.token);
        }}
      >
        复制 token
      </button>
      <button
        className="link-btn"
        onClick={() => {
          setGuest(null);
          toast(`已退出。「${guest.name}」保留在本机，可在「用过的身份」里切回`, 'info');
        }}
      >
        退出
      </button>
    </span>
  );
}
