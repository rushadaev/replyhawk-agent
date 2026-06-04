import { useEffect, useState } from 'react';

type Heartbeat =
  | { ok: true; ts: number }
  | { ok: false; reason: 'no_token' | 'unauthorized' | 'unreachable'; detail?: string };

type Status = { status: string; lastTick?: number; lastError?: string };
type PollerStatus = Status & { sentCount: number; failedCount: number; pendingCount: number };
type PollerLog = Array<{ at: number; leadId: string; source: string; status: 'sent' | 'failed'; text: string; error?: string }>;
type Snapshot =
  | { ok: true; counts: Record<string, number>; total: number; callQueue: Array<{ id: string; name: string; source: string; status: string }> }
  | { ok: false; error: string };
type Source = 'yelp' | 'thumbtack';

export default function App(): React.JSX.Element {
  const [hasToken, setHasToken] = useState<boolean | null>(null);
  const [tokenPreview, setTokenPreview] = useState<string | undefined>();
  const [hb, setHb] = useState<Heartbeat | null>(null);
  const [tokenInput, setTokenInput] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  const [chromes, setChromes] = useState<Array<{ platform: Source; running: boolean; hidden: boolean }>>([]);
  const [watcher, setWatcher] = useState<{ yelp: Status; thumbtack: Status; poller?: PollerStatus } | null>(null);
  const [pollerLog, setPollerLog] = useState<PollerLog>([]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [yelpLog, setYelpLog] = useState<Array<{ at: number; ingested: number; total: number; note?: string }>>([]);
  const [yelpShot, setYelpShot] = useState<{ at: number; b64: string } | null>(null);
  const [showYelpShot, setShowYelpShot] = useState(false);
  const [ttLog, setTtLog] = useState<Array<{ at: number; ingested: number; total: number; note?: string }>>([]);
  const [ttShot, setTtShot] = useState<{ at: number; b64: string } | null>(null);
  const [showTtShot, setShowTtShot] = useState(false);
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
      const yelpRunning = c.find((x) => x.platform === 'yelp')?.running;
      const detected = yelpRunning ? await window.api.watcher.yelpDetect() : null;
      const yLog = w.yelp.status !== 'idle' ? await window.api.watcher.yelpLog() : [];
      const yShot = (showYelpShot && w.yelp.status !== 'idle') ? await window.api.watcher.yelpScreenshot() : null;
      const tLog = w.thumbtack.status !== 'idle' ? await window.api.watcher.thumbtackLog() : [];
      const tShot = (showTtShot && w.thumbtack.status !== 'idle') ? await window.api.watcher.thumbtackScreenshot() : null;
      const pLog = await window.api.poller.log();
      const snap = r.ok ? await window.api.cloud.snapshot() : null;
      if (cancelled) return;
      setHb(r); setChromes(c); setWatcher(w); setYelpBiz(detected);
      setYelpLog(yLog); setYelpShot(yShot);
      setTtLog(tLog); setTtShot(tShot);
      setPollerLog(pLog); setSnapshot(snap);
    };
    tick();
    const t = setInterval(tick, 5_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [hasToken, showYelpShot, showTtShot]);

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
        onHide={() => window.api.chrome.hide('yelp')}
        onPollNow={async () => {
          const r = await window.api.watcher.yelpPollNow();
          if (r.ok) alert(`Polled: ${r.ingested} new lead(s) ingested of ${r.total} total in inbox.`);
          else alert(`Poll failed: ${r.error}`);
        }}
        log={yelpLog}
        showPreview={showYelpShot}
        onTogglePreview={() => setShowYelpShot((v) => !v)}
        screenshot={yelpShot}
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
        onHide={() => window.api.chrome.hide('thumbtack')}
        onPollNow={async () => {
          const r = await window.api.watcher.thumbtackPollNow();
          if (r.ok) alert(`Polled: ${r.ingested} new thread(s) ingested of ${r.total} total in inbox.`);
          else alert(`Poll failed: ${r.error}`);
        }}
        log={ttLog}
        showPreview={showTtShot}
        onTogglePreview={() => setShowTtShot((v) => !v)}
        screenshot={ttShot}
      />

      <ReplyQueueCard poller={watcher?.poller} log={pollerLog} />
      <PipelineCard snapshot={snapshot} />

      <div className="muted small mono">paired as {tokenPreview}</div>
    </Shell>
  );
}

// Reply queue: what the agent is sending via Chrome (AI-drafted or operator-typed replies).
function ReplyQueueCard(props: { poller?: PollerStatus; log: PollerLog }): React.JSX.Element {
  const p = props.poller;
  const active = p && p.status !== 'idle';
  return (
    <div className="card">
      <div className="row between">
        <h3>Reply queue</h3>
        <div className="muted small">
          {!active && 'Idle — starts when a watcher is running'}
          {active && (
            <>
              <span className="pill">{p!.pendingCount} pending</span>
              <span className="pill green">{p!.sentCount} sent</span>
              {p!.failedCount > 0 && <span className="pill red">{p!.failedCount} failed</span>}
            </>
          )}
        </div>
      </div>
      <p className="hint">
        Text replies the cloud queued (AI-drafted or typed by you in the dashboard). The agent sends each one
        through your real Chrome and reports back.
      </p>
      {props.log.length === 0 ? (
        <div className="muted small">No replies sent yet.</div>
      ) : (
        <div className="poll-log">
          {props.log.map((l, i) => (
            <div key={i} className={`poll-row ${l.status === 'failed' ? 'err' : ''}`}>
              <span className="mono">{new Date(l.at).toLocaleTimeString()}</span>
              <span className={`tag ${l.source}`}>{l.source}</span>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {l.status === 'sent' ? '✓ ' : '✗ '}
                {l.error ? l.error : l.text}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Pipeline snapshot from the cloud, including the call queue (calls run server-side via the
// voice agent — this is a read-only view of what's queued / in progress).
function PipelineCard(props: { snapshot: Snapshot | null }): React.JSX.Element {
  const s = props.snapshot;
  const labels: Record<string, string> = {
    new: 'New', ready: 'Ready to call', calling: 'Calling', contacted: 'Contacted',
    no_answer: 'No answer', engaged: 'Engaged', booked: 'Booked',
    not_interested: 'Not interested', do_not_call: 'Do not call',
  };
  const order = ['new', 'ready', 'calling', 'contacted', 'no_answer', 'engaged', 'booked', 'not_interested', 'do_not_call'];
  return (
    <div className="card">
      <div className="row between">
        <h3>Pipeline &amp; calls</h3>
        <div className="muted small">{s?.ok ? `${s.total} leads` : ''}</div>
      </div>
      {!s ? (
        <div className="muted small">Connect to load…</div>
      ) : !s.ok ? (
        <div className="error">{s.error}</div>
      ) : (
        <>
          <div className="stat-grid">
            {order.filter((k) => s.counts[k]).map((k) => (
              <div key={k} className="stat">
                <div className="stat-num">{s.counts[k]}</div>
                <div className="stat-label">{labels[k] ?? k}</div>
              </div>
            ))}
          </div>
          <div className="muted small" style={{ marginTop: 12, marginBottom: 4 }}>
            Call queue — calls placed by the voice agent (server-side)
          </div>
          {s.callQueue.length === 0 ? (
            <div className="muted small">Nothing queued to call.</div>
          ) : (
            <div className="poll-log">
              {s.callQueue.map((l) => (
                <div key={l.id} className="poll-row">
                  <span className={`tag ${l.source}`}>{l.source}</span>
                  <span style={{ flex: 1 }}>{l.name}</span>
                  <span className={`pill ${l.status === 'calling' ? 'green' : ''}`}>
                    {l.status === 'calling' ? 'calling…' : 'queued'}
                  </span>
                </div>
              ))}
            </div>
          )}
          <p className="hint">Manage calls, transcripts &amp; outcomes in the ReplyHawk dashboard.</p>
        </>
      )}
    </div>
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
  onHide: () => void;
  onPollNow?: () => void;
  log?: Array<{ at: number; ingested: number; total: number; note?: string }>;
  showPreview?: boolean;
  onTogglePreview?: () => void;
  screenshot?: { at: number; b64: string } | null;
}): React.JSX.Element {
  const ws = props.watcherStatus;
  const watching = ws?.status === 'watching';
  return (
    <div className="card">
      <div className="row between">
        <div style={{ minWidth: 0, flex: 1 }}>
          <h3>{props.name}</h3>
          <div className="muted small">
            {!props.running && 'Not connected'}
            {props.running && !watching && !props.hidden && 'Chrome open — log in then start watcher'}
            {watching && props.hidden && `Watching in background · last tick ${ws?.lastTick ? new Date(ws.lastTick).toLocaleTimeString() : '—'}`}
            {watching && !props.hidden && `Watching · last tick ${ws?.lastTick ? new Date(ws.lastTick).toLocaleTimeString() : '—'}`}
            {ws?.lastError && <span className="error"> · {ws.lastError}</span>}
          </div>
        </div>
        <div className="actions">
          {!props.running ? (
            <button className="primary" disabled={props.busy} onClick={props.onConnect}>Open Chrome</button>
          ) : props.hidden ? (
            <button className="ghost" disabled={props.busy} onClick={props.onShowWindow}>Show window</button>
          ) : watching ? (
            <button className="ghost" disabled={props.busy} onClick={props.onHide}>Hide</button>
          ) : (
            <button className="ghost" disabled={props.busy} onClick={props.onDisconnect}>Close Chrome</button>
          )}
          {props.running && !watching && (
            <button className="primary" disabled={props.busy} onClick={props.onStartWatch}>Start watching</button>
          )}
          {watching && (
            <>
              {props.onTogglePreview && (
                <button className="ghost" disabled={props.busy} onClick={props.onTogglePreview}>
                  {props.showPreview ? 'Hide preview' : 'Live view'}
                </button>
              )}
              {props.onPollNow && (
                <button className="ghost" disabled={props.busy} onClick={props.onPollNow}>Poll now</button>
              )}
              <button className="ghost" disabled={props.busy} onClick={props.onStopWatch}>Pause</button>
            </>
          )}
        </div>
      </div>
      {props.extra}
      <p className="hint">{props.loginHint}</p>
      {watching && props.showPreview && (
        <div className="preview">
          {props.screenshot ? (
            <>
              <div className="muted small">Live view · captured {new Date(props.screenshot.at).toLocaleTimeString()}</div>
              <img className="shot" alt="Inbox preview" src={`data:image/jpeg;base64,${props.screenshot.b64}`} />
            </>
          ) : (
            <div className="muted small">Capturing… (refreshes on the next poll cycle)</div>
          )}
        </div>
      )}
      {watching && props.log && props.log.length > 0 && (
        <div className="poll-log">
          {props.log.slice(0, 6).map((l, i) => (
            <div key={i} className={`poll-row ${l.note ? 'err' : ''}`}>
              <span className="mono">{new Date(l.at).toLocaleTimeString()}</span>
              <span>{l.note ?? (l.ingested > 0 ? `+${l.ingested} new of ${l.total} total` : `no changes (${l.total} total)`)}</span>
            </div>
          ))}
        </div>
      )}
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
.container { max-width: 820px; margin: 0 auto; padding: 36px 24px; }
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
.primary { padding: 8px 14px; background: #3b82f6; border: 0; border-radius: 6px; color: #fff; font-weight: 600; cursor: pointer; white-space: nowrap; }
.primary:disabled { opacity: .5; cursor: not-allowed; }
.ghost { padding: 6px 12px; background: transparent; border: 1px solid #2a2f3a; border-radius: 6px; color: #e6e6e6; cursor: pointer; font-size: 13px; white-space: nowrap; }
.ghost:hover { background: #14181f; }
.actions { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; max-width: 60%; }
.card { background: #14181f; border: 1px solid #2a2f3a; border-radius: 8px; padding: 16px; margin: 14px 0; }
.preview { margin-top: 10px; border-top: 1px solid #2a2f3a; padding-top: 8px; }
.preview .shot { width: 100%; border: 1px solid #2a2f3a; border-radius: 6px; margin-top: 6px; display: block; }
.poll-log { margin-top: 10px; border-top: 1px solid #2a2f3a; padding-top: 8px; max-height: 140px; overflow-y: auto; }
.poll-row { display: flex; gap: 10px; font-size: 12px; color: #8a93a3; padding: 2px 0; }
.poll-row .mono { font-family: ui-monospace, monospace; min-width: 80px; }
.poll-row.err { color: #f87171; }
.status-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.status-dot.green { background: #22c55e; }
.status-dot.red { background: #ef4444; }
.status-dot.gray { background: #6b7280; }
.pill { display: inline-block; padding: 2px 8px; margin-left: 6px; border-radius: 999px; font-size: 11px; background: #1f2530; color: #cbd5e1; border: 1px solid #2a2f3a; }
.pill.green { background: #0f2a1a; color: #4ade80; border-color: #14532d; }
.pill.red { background: #2a1414; color: #f87171; border-color: #7f1d1d; }
.tag { display: inline-block; min-width: 64px; text-align: center; padding: 1px 6px; border-radius: 4px; font-size: 11px; font-weight: 600; background: #1f2530; color: #94a3b8; }
.tag.yelp { background: #2a1411; color: #fb7185; }
.tag.thumbtack { background: #0d1f2a; color: #38bdf8; }
.stat-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(92px, 1fr)); gap: 8px; margin-top: 10px; }
.stat { background: #0f1318; border: 1px solid #2a2f3a; border-radius: 6px; padding: 8px 10px; }
.stat-num { font-size: 20px; font-weight: 700; line-height: 1; }
.stat-label { font-size: 11px; color: #8a93a3; margin-top: 4px; }
`;
