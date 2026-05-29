import { useEffect, useState } from 'react';

type Heartbeat =
  | { ok: true; ts: number }
  | { ok: false; reason: 'no_token' | 'unauthorized' | 'unreachable'; detail?: string };

type Status = { status: string; lastTick?: number; lastError?: string };
type Source = 'yelp' | 'thumbtack';

export default function App(): React.JSX.Element {
  const [hasToken, setHasToken] = useState<boolean | null>(null);
  const [tokenPreview, setTokenPreview] = useState<string | undefined>();
  const [hb, setHb] = useState<Heartbeat | null>(null);
  const [tokenInput, setTokenInput] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  const [chromes, setChromes] = useState<Array<{ platform: Source; running: boolean; hidden: boolean }>>([]);
  const [watcher, setWatcher] = useState<{ yelp: Status; thumbtack: Status } | null>(null);
  const [yelpBiz, setYelpBiz] = useState<string | null>(null);
  const [busy, setBusy] = useState<Source | null>(null);

  useEffect(() => {
    void (async () => {
      const r = await window.api.auth.getToken();
      setHasToken(r.hasToken);
      setTokenPreview(r.preview);
    })();
  }, []);

  useEffect(() => {
    if (!hasToken) return;
    let cancelled = false;
    const tick = async (): Promise<void> => {
      const r = await window.api.cloud.heartbeat();
      const c = await window.api.chrome.list();
      const w = await window.api.watcher.status();
      // Auto-detect Yelp biz encid from any open tab whenever Yelp Chrome is running
      const yelpRunning = c.find((x) => x.platform === 'yelp')?.running;
      const detected = yelpRunning ? await window.api.watcher.yelpDetect() : null;
      if (cancelled) return;
      setHb(r); setChromes(c); setWatcher(w); setYelpBiz(detected);
    };
    tick();
    const t = setInterval(tick, 5_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [hasToken]);

  async function onSave(): Promise<void> {
    const token = tokenInput.trim();
    if (!token) return;
    setVerifying(true); setVerifyError(null);
    const v = await window.api.auth.verifyToken(token);
    if (!v.ok) { setVerifyError(v.error); setVerifying(false); return; }
    await window.api.auth.setToken(token);
    const r = await window.api.auth.getToken();
    setHasToken(r.hasToken); setTokenPreview(r.preview); setTokenInput(''); setVerifying(false);
  }

  async function onUnpair(): Promise<void> {
    await window.api.auth.clearToken();
    setHasToken(false); setTokenPreview(undefined); setHb(null);
  }

  async function onConnect(source: Source): Promise<void> {
    setBusy(source);
    await window.api.chrome.start(source);
    setBusy(null);
  }

  async function onDisconnect(source: Source): Promise<void> {
    setBusy(source);
    if (source === 'yelp') await window.api.watcher.yelpStop();
    else await window.api.watcher.thumbtackStop();
    await window.api.chrome.stop(source);
    setBusy(null);
  }

  async function onStartWatch(source: Source): Promise<void> {
    setBusy(source);
    if (source === 'yelp') {
      // The watcher itself will detect the biz encid from any open tab if not already set.
      const r = await window.api.watcher.yelpStart();
      if (!r.ok) alert('Yelp watcher failed: ' + r.error);
      else if (r.bizEncid) setYelpBiz(r.bizEncid);
    } else {
      const r = await window.api.watcher.thumbtackStart();
      if (!r.ok) alert('Thumbtack watcher failed: ' + r.error);
    }
    setBusy(null);
  }

  if (hasToken === null) return <Shell><div className="muted">Loading…</div></Shell>;

  if (!hasToken) {
    return (
      <Shell>
        <h1>Welcome to ReplyHawk Agent</h1>
        <p className="muted">Paste your <strong>agent token</strong> to pair this Mac with your ReplyHawk account.</p>
        <input autoFocus className="input" placeholder="agt_… or your INGEST_API_KEY"
               value={tokenInput} onChange={(e) => setTokenInput(e.target.value)}
               onKeyDown={(e) => e.key === 'Enter' && onSave()} />
        {verifyError && <div className="error">{verifyError}</div>}
        <button className="primary" onClick={onSave} disabled={!tokenInput.trim() || verifying}>
          {verifying ? 'Verifying…' : 'Pair this Mac'}
        </button>
      </Shell>
    );
  }

  const yelpChrome = chromes.find((c) => c.platform === 'yelp');
  const ttChrome = chromes.find((c) => c.platform === 'thumbtack');

  return (
    <Shell>
      <div className="row">
        <h1 style={{ margin: 0 }}>ReplyHawk Agent</h1>
        <span className={`status-dot ${hb?.ok ? 'green' : hb ? 'red' : 'gray'}`} />
        <span className="muted small">
          {hb?.ok ? `connected · ${new Date(hb.ts).toLocaleTimeString()}` : hb ? hb.reason : '…'}
        </span>
        <button className="ghost right" onClick={onUnpair}>Unpair</button>
      </div>

      <SourceCard
        name="Yelp Biz"
        running={!!yelpChrome?.running}
        hidden={!!yelpChrome?.hidden}
        watcherStatus={watcher?.yelp}
        busy={busy === 'yelp'}
        loginHint={yelpBiz
          ? `Detected business ${yelpBiz}. Hit "Start watching" to begin polling.`
          : 'Sign into biz.yelp.com in the opened Chrome window. We\'ll auto-detect your business ID from the URL.'}
        onConnect={() => onConnect('yelp')}
        onDisconnect={() => onDisconnect('yelp')}
        onStartWatch={() => onStartWatch('yelp')}
        onStopWatch={() => window.api.watcher.yelpStop()}
        onShowWindow={() => window.api.chrome.show('yelp')}
      />

      <SourceCard
        name="Thumbtack Pro"
        running={!!ttChrome?.running}
        hidden={!!ttChrome?.hidden}
        watcherStatus={watcher?.thumbtack}
        busy={busy === 'thumbtack'}
        loginHint="Sign into thumbtack.com once. We'll poll /pro-inbox/ for new threads."
        onConnect={() => onConnect('thumbtack')}
        onDisconnect={() => onDisconnect('thumbtack')}
        onStartWatch={() => onStartWatch('thumbtack')}
        onStopWatch={() => window.api.watcher.thumbtackStop()}
        onShowWindow={() => window.api.chrome.show('thumbtack')}
      />

      <div className="muted small mono">paired as {tokenPreview}</div>
    </Shell>
  );
}

function SourceCard(props: {
  name: string;
  running: boolean;
  hidden: boolean;
  watcherStatus?: Status;
  busy: boolean;
  loginHint: string;
  extra?: React.ReactNode;
  onConnect: () => void;
  onDisconnect: () => void;
  onStartWatch: () => void;
  onStopWatch: () => void;
  onShowWindow: () => void;
}): React.JSX.Element {
  const ws = props.watcherStatus;
  const watching = ws?.status === 'watching';
  return (
    <div className="card">
      <div className="row between">
        <div>
          <h3>{props.name}</h3>
          <div className="muted small">
            {!props.running && 'Not connected'}
            {props.running && !watching && !props.hidden && 'Chrome open — log in then start watcher'}
            {watching && props.hidden && `Watching in background · last tick ${ws?.lastTick ? new Date(ws.lastTick).toLocaleTimeString() : '—'}`}
            {watching && !props.hidden && `Watching · last tick ${ws?.lastTick ? new Date(ws.lastTick).toLocaleTimeString() : '—'}`}
            {ws?.lastError && <span className="error"> · {ws.lastError}</span>}
          </div>
        </div>
        <div className="row">
          {!props.running ? (
            <button className="primary" disabled={props.busy} onClick={props.onConnect}>Open Chrome</button>
          ) : props.hidden ? (
            <button className="ghost" disabled={props.busy} onClick={props.onShowWindow}>Show window</button>
          ) : (
            <button className="ghost" disabled={props.busy} onClick={props.onDisconnect}>Close Chrome</button>
          )}
          {props.running && !watching && (
            <button className="primary" disabled={props.busy} onClick={props.onStartWatch}>Start watching</button>
          )}
          {watching && (
            <button className="ghost" disabled={props.busy} onClick={props.onStopWatch}>Pause</button>
          )}
        </div>
      </div>
      {props.extra}
      <p className="hint">{props.loginHint}</p>
    </div>
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
.container { max-width: 620px; margin: 0 auto; padding: 36px 24px; }
h1 { font-size: 22px; margin: 0 0 8px; }
h3 { font-size: 14px; margin: 0 0 4px; font-weight: 600; }
p { margin: 4px 0 12px; }
.muted { color: #8a93a3; }
.small { font-size: 12px; }
.hint { color: #6b7280; font-size: 12px; margin: 8px 0 0; }
.mono { font-family: ui-monospace,SFMono-Regular,monospace; font-size: 12px; }
.row { display: flex; align-items: center; gap: 10px; }
.row.between { justify-content: space-between; }
.row .right { margin-left: auto; }
.input { width: 100%; padding: 10px 12px; background: #14181f; border: 1px solid #2a2f3a; border-radius: 6px; color: #e6e6e6; font-family: ui-monospace,monospace; font-size: 13px; margin: 8px 0; }
.input.small { padding: 6px 8px; font-size: 12px; }
.input:focus { outline: 1px solid #3b82f6; }
.error { color: #f87171; font-size: 12px; }
.primary { padding: 8px 14px; background: #3b82f6; border: 0; border-radius: 6px; color: #fff; font-weight: 600; cursor: pointer; }
.primary:disabled { opacity: .5; cursor: not-allowed; }
.ghost { padding: 6px 12px; background: transparent; border: 1px solid #2a2f3a; border-radius: 6px; color: #e6e6e6; cursor: pointer; font-size: 13px; }
.ghost:hover { background: #14181f; }
.card { background: #14181f; border: 1px solid #2a2f3a; border-radius: 8px; padding: 16px; margin: 14px 0; }
.status-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.status-dot.green { background: #22c55e; }
.status-dot.red { background: #ef4444; }
.status-dot.gray { background: #6b7280; }
`;
