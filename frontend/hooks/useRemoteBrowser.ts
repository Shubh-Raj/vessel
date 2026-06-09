'use client';

import { useRef, useState, useCallback, useEffect } from 'react';

export type SessionState = 'idle' | 'connecting' | 'booting' | 'active' | 'error';

export interface RemoteBrowserState {
  sessionState: SessionState;
  statusMsg:    string;
  fps:          number;
}

export interface RemoteBrowserActions {
  connect:    () => void;
  disconnect: () => void;
  send:       (msg: object) => void;
  setOnFrame: (cb: (data: string) => void) => void;
}

const WS_URL = 'ws://localhost:3000';

export function useRemoteBrowser(): RemoteBrowserState & RemoteBrowserActions {
  const [sessionState, setSessionState] = useState<SessionState>('idle');
  const [statusMsg, setStatusMsg]       = useState('');
  const [fps, setFps]                   = useState(0);

  const wsRef         = useRef<WebSocket | null>(null);
  const frameCountRef = useRef(0);
  const onFrameRef    = useRef<((data: string) => void) | null>(null);

  useEffect(() => {
    const timer = setInterval(() => {
      setFps(frameCountRef.current);
      frameCountRef.current = 0;
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const connect = useCallback(() => {
    if (wsRef.current) return;
    setSessionState('connecting');
    setStatusMsg('Connecting to backend...');

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setSessionState('booting');
      setStatusMsg('Starting Docker container...');
    };

    ws.onmessage = (e: MessageEvent) => {
      const msg = JSON.parse(e.data as string);
      switch (msg.type) {
        case 'frame':
          frameCountRef.current++;
          onFrameRef.current?.(msg.data as string);
          break;
        case 'status':
          if (msg.message === 'container_starting') {
            setSessionState('booting');
            setStatusMsg('Launching Chromium in container...');
          } else if (msg.message === 'session_ready') {
            setSessionState('active');
            setStatusMsg('');
          } else if (msg.message === 'container_closed') {
            setSessionState('idle');
            setStatusMsg('');
          }
          break;
        case 'error':
          setSessionState('error');
          setStatusMsg(msg.message as string);
          break;
      }
    };

    ws.onclose = () => {
      setSessionState('idle');
      setStatusMsg('');
      wsRef.current = null;
    };

    ws.onerror = () => {
      setSessionState('error');
      setStatusMsg('Cannot connect to backend. Is `node server.js` running in backend/?');
      wsRef.current = null;
    };
  }, []);

  const disconnect = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
    setSessionState('idle');
    setStatusMsg('');
  }, []);

  const send = useCallback((msg: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const setOnFrame = useCallback((cb: (data: string) => void) => {
    onFrameRef.current = cb;
  }, []);

  return { sessionState, statusMsg, fps, connect, disconnect, send, setOnFrame };
}
