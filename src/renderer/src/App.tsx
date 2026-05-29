import { useEffect, useState } from 'react';

type Heartbeat =
  | { ok: true; ts: number }
  | { ok: false; reason: 'no_token' | 'unauthorized' | 'unreachable'; detail?: string };

export default function App(): React.JSX.Element {
  const [hasToken, setHasToken] = useState<boolean | null>(null);
  const [tokenPreview, setTokenPreview] = useState<string | undefined>();
  const [hb, setHb] = useState<Heartbeat | null>(null);
  const [tokenInput, setTokenInput] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  // Initial token check
  useEffect(() => {
    void (async () => {
      const r = await window.api.auth.getToken();
      setHasToken(r.hasToken);
      setTokenPreview(r.preview);
    })();
  }, []);

  // Heartbeat loop once token is in place
  useEffect(() => {
    if (!hasToken) return;
    let cancelled = false;
    const tick = async () => {
      const r = await window.api.cloud.heartbeat();
      if (!cancelled) setHb(r);
    };
    tick();
    const t = setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [hasToken]);

  async function onSave(): Promise<void> {
    const token = tokenInput.trim();
    if (!token) return;
    setVerifying(true);
    setVerifyError(null);
    const v = await window.api.auth.verifyToken(token);
    if (!v.ok) {
      setVerifyError(v.error);
      setVerifying(false);
      return;
    }
    await window.api.auth.setToken(token);
    const r = await window.api.auth.getToken();
    setHasToken(r.hasToken);
    setTokenPreview(r.preview);
    setTokenInput('');
    setVerifying(false);
  }

  async function onUnpair(): Promise<void> {
    await window.api.auth.clearToken();
    setHasToken(false);
    setTokenPreview(undefined);
    setHb(null);
  }

  if (hasToken === null) return <Shell><div className="text-muted">Loading…</div></Shell>;

  if (!hasToken) {
    return (
      <Shell>
        <h1>Welcome to ReplyHawk Agent</h1>
        <p className="muted">
          Paste your <strong>agent token</strong> to pair this Mac with your ReplyHawk account.
        </p>
        <p className="hint">
          Find your token at <code>https://reply-hawk.com</code> → Settings → Agents. Or, for the demo, use the
          INGEST_API_KEY from Railway.
        </p>
        <input
          autoFocus
          className="input"
          placeholder="agt_… or your INGEST_API_KEY"
          value={tokenInput}
          onChange={(e) => setTokenInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onSave()}
        />
        {verifyError && <div className="error">{verifyError}</div>}
        <button className="primary" onClick={onSave} disabled={!tokenInput.trim() || verifying}>
          {verifying ? 'Verifying…' : 'Pair this Mac'}
        </button>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="row">
        <h1 style={{ margin: 0 }}>ReplyHawk Agent</h1>
        <span className={`status-dot ${hb?.ok ? 'green' : hb ? 'red' : 'gray'}`} />
        <span className="muted small">
          {hb?.ok
            ? `connected · ${new Date(hb.ts).toLocaleTimeString()}`
            : hb
              ? hb.reason === 'unauthorized'
                ? 'token rejected'
                : hb.reason === 'unreachable'
                  ? 'cloud unreachable'
                  : 'no token'
              : '…'}
        </span>
      </div>

      <div className="card">
        <div className="row between">
          <div>
            <div className="muted small">Paired with cloud</div>
            <div className="mono">{tokenPreview}</div>
          </div>
          <button className="ghost" onClick={onUnpair}>Unpair</button>
        </div>
      </div>

      <div className="card">
        <h3>Next steps (coming in the next builds)</h3>
        <ul className="muted">
          <li>Connect your Yelp Biz account (real Chrome, log in once)</li>
          <li>Connect your Thumbtack Pro account</li>
          <li>Background watchers pick up new leads + messages</li>
          <li>Cloud sends reply commands back through this app</li>
        </ul>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="container">
      <style>{css}</style>
      <div className="content">{children}</div>
    </div>
  );
}

const css = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body, html, #root { margin:0; padding:0; height:100%; background:#0b0d10; color:#e6e6e6; font:14px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif; }
.container { max-width: 560px; margin: 0 auto; padding: 48px 24px; }
h1 { font-size: 22px; margin: 0 0 8px; }
h3 { font-size: 14px; margin: 0 0 8px; text-transform: uppercase; letter-spacing: .05em; color: #8a93a3; font-weight: 600; }
p { margin: 4px 0 12px; }
.muted { color: #8a93a3; }
.small { font-size: 12px; }
.hint { color: #6b7280; font-size: 12px; margin: 0 0 16px; }
.mono { font-family: ui-monospace,SFMono-Regular,monospace; font-size: 13px; }
.row { display: flex; align-items: center; gap: 10px; }
.row.between { justify-content: space-between; }
.input { width: 100%; padding: 10px 12px; background: #14181f; border: 1px solid #2a2f3a; border-radius: 6px; color: #e6e6e6; font-family: ui-monospace,monospace; font-size: 13px; margin-bottom: 8px; }
.input:focus { outline: 1px solid #3b82f6; }
.error { color: #f87171; font-size: 13px; margin-bottom: 8px; }
.primary { padding: 10px 16px; background: #3b82f6; border: 0; border-radius: 6px; color: #fff; font-weight: 600; cursor: pointer; }
.primary:disabled { opacity: .5; cursor: not-allowed; }
.ghost { padding: 6px 12px; background: transparent; border: 1px solid #2a2f3a; border-radius: 6px; color: #e6e6e6; cursor: pointer; font-size: 13px; }
.ghost:hover { background: #14181f; }
.card { background: #14181f; border: 1px solid #2a2f3a; border-radius: 8px; padding: 16px; margin: 16px 0; }
.status-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.status-dot.green { background: #22c55e; }
.status-dot.red { background: #ef4444; }
.status-dot.gray { background: #6b7280; }
ul { padding-left: 18px; margin: 8px 0; }
li { margin: 2px 0; font-size: 13px; }
code { background: #14181f; padding: 1px 6px; border-radius: 3px; }
`;
