'use client';

import { useRef, useEffect, useState, useCallback } from 'react';
import { useRemoteBrowser, SessionState } from '../hooks/useRemoteBrowser';

function LandingView({ onStart }: { onStart: () => void }) {
  return (
    <div className="landing animate-in">
      <div className="landing-badge">
        <span className="landing-badge-dot" />
        Remote Browser Control
      </div>

      <div className="landing-hero">
        <h1 className="landing-title">Browse</h1>
        <p className="landing-subtitle">
          Stream and control a real Chromium browser running in a Docker container,
          from right here in the browser tab.
        </p>
      </div>

      <button className="start-btn" onClick={onStart} id="start-browser-btn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="5 3 19 12 5 21 5 3" />
        </svg>
        Start Browser
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12h14M12 5l7 7-7 7" />
        </svg>
      </button>

      <div className="flow-steps">
        {[
          { n: '1', text: 'Click "Start Browser"' },
          { n: '2', text: 'Docker spins up Chromium' },
          { n: '3', text: 'Stream appears — interact live' },
        ].map((step, i, arr) => (
          <span key={step.n} style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
            <span className="flow-step">
              <span className="flow-step-num">{step.n}</span>
              <span className="flow-step-text">{step.text}</span>
            </span>
            {i < arr.length - 1 && <span className="flow-arrow">›</span>}
          </span>
        ))}
      </div>
    </div>
  );
}

function StatusPill({ state, msg }: { state: SessionState; msg: string }) {
  const labels: Record<SessionState, string> = {
    idle:         'Idle',
    connecting:   'Connecting...',
    reconnecting: msg || 'Resuming session...',
    booting:      msg || 'Starting container...',
    active:       'Live',
    error:        msg || 'Error',
  };
  return (
    <span className={`status-pill ${state}`}>
      <span className="status-dot" />
      {labels[state]}
    </span>
  );
}

interface StreamViewProps {
  sessionState: SessionState;
  statusMsg:    string;
  fps:          number;
  send:         (msg: object) => void;
  setOnFrame:   (cb: (data: string) => void) => void;
  onStop:       () => void;
}

function StreamView({ sessionState, statusMsg, fps, send, setOnFrame, onStop }: StreamViewProps) {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [url, setUrl] = useState('https://google.com');

  useEffect(() => {
    setOnFrame((base64: string) => {
      if (imgRef.current) {
        imgRef.current.src = 'data:image/jpeg;base64,' + base64;
      }
    });
  }, [setOnFrame]);

  const handleClick = useCallback((e: React.MouseEvent<HTMLImageElement>) => {
    if (sessionState !== 'active') return;
    const rect = e.currentTarget.getBoundingClientRect();
    send({
      type: 'click',
      x: (e.clientX - rect.left) / rect.width,
      y: (e.clientY - rect.top)  / rect.height,
    });
  }, [sessionState, send]);

  const handleWheel = useCallback((e: React.WheelEvent<HTMLImageElement>) => {
    if (sessionState !== 'active') return;
    const rect = e.currentTarget.getBoundingClientRect();
    send({
      type: 'scroll',
      x: (e.clientX - rect.left) / rect.width,
      y: (e.clientY - rect.top)  / rect.height,
      deltaY: e.deltaY,
    });
  }, [sessionState, send]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (sessionState !== 'active') return;
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      e.preventDefault();
      if (e.key.length === 1) {
        send({ type: 'type', text: e.key });
      } else {
        send({ type: 'keydown', key: e.key });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sessionState, send]);

  const navigate = () => send({ type: 'navigate', url });
  const isBooting = sessionState === 'connecting' || sessionState === 'booting' || sessionState === 'reconnecting';

  return (
    <div className="stream-page">
      <div className="topbar">
        <span className="topbar-logo">browse</span>
        <StatusPill state={sessionState} msg={statusMsg} />
        <span className="topbar-spacer" />
        <span className="fps-badge">{sessionState === 'active' ? `${fps} fps` : ''}</span>
        <button className="end-btn" onClick={onStop} id="end-session-btn">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
          </svg>
          End Session
        </button>
      </div>

      <div className="urlbar">
        <input
          id="url-input"
          className="urlbar-input"
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') navigate(); }}
          placeholder="https://..."
          disabled={isBooting}
          spellCheck={false}
        />
        <button
          id="navigate-btn"
          className="urlbar-btn"
          onClick={navigate}
          disabled={isBooting}
        >
          Go
        </button>
      </div>

      <div className="stream-area">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={imgRef}
          className="stream-img"
          alt="Remote browser stream"
          onClick={handleClick}
          onWheel={handleWheel}
          draggable={false}
          id="stream-img"
        />

        {isBooting && (
          <div className="booting-overlay animate-in">
            <div className="spinner" />
            <p className="booting-text">{statusMsg || 'Starting...'}</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default function Home() {
  const { sessionState, statusMsg, fps, connect, disconnect, send, setOnFrame } =
    useRemoteBrowser();

  const isStreaming = sessionState !== 'idle';

  return (
    <main>
      {!isStreaming ? (
        <LandingView onStart={connect} />
      ) : (
        <StreamView
          sessionState={sessionState}
          statusMsg={statusMsg}
          fps={fps}
          send={send}
          setOnFrame={setOnFrame}
          onStop={disconnect}
        />
      )}
    </main>
  );
}
