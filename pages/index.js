import { useEffect, useMemo, useRef, useState } from "react";

const USER_A = "A";
const USER_B = "B";
const DEFAULT_WORKER_PORT = "8787";
const RTC_CONFIG = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

function resolveWorkerUrl() {
  const envUrl = process.env.NEXT_PUBLIC_WORKER_URL?.trim();
  if (envUrl) {
    return envUrl;
  }

  if (typeof window !== "undefined") {
    const protocol = window.location.protocol === "https:" ? "https" : "http";
    return `${protocol}://${window.location.hostname}:${DEFAULT_WORKER_PORT}`;
  }

  return `http://127.0.0.1:${DEFAULT_WORKER_PORT}`;
}

function buildWebSocketUrl(workerUrl, roomId) {
  const raw = workerUrl.trim().replace(/\/+$/, "");

  if (!raw) {
    throw new Error("WORKER_URL is empty");
  }

  if (raw.startsWith("ws://") || raw.startsWith("wss://")) {
    return `${raw}/room/${roomId}`;
  }

  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    const url = new URL(raw);
    const wsProtocol = url.protocol === "https:" ? "wss:" : "ws:";
    return `${wsProtocol}//${url.host}/room/${roomId}`;
  }

  const isLocalHost =
    raw.startsWith("localhost") ||
    raw.startsWith("127.0.0.1") ||
    raw.startsWith("0.0.0.0");
  const wsProtocol = isLocalHost ? "ws" : "wss";
  return `${wsProtocol}://${raw}/room/${roomId}`;
}

function formatMediaError(error) {
  const errorName = error?.name || "UnknownError";

  if (errorName === "NotAllowedError") {
    return "Camera/microphone permission was denied.";
  }

  if (errorName === "NotFoundError") {
    return "No camera or microphone device was found.";
  }

  if (errorName === "NotReadableError") {
    return "Camera/microphone is busy or blocked by another app.";
  }

  return String(error);
}

const styles = {
  page: {
    minHeight: "100vh",
    fontFamily: "Segoe UI, sans-serif",
    padding: 20,
    background: "#f6f7fb",
    color: "#1f2937",
  },
  card: {
    maxWidth: 760,
    margin: "0 auto",
    background: "#ffffff",
    border: "1px solid #e5e7eb",
    borderRadius: 12,
    padding: 16,
    boxShadow: "0 8px 20px rgba(0, 0, 0, 0.06)",
  },
  row: {
    display: "flex",
    gap: 8,
    alignItems: "center",
    flexWrap: "wrap",
  },
  input: {
    flex: 1,
    minWidth: 220,
    padding: "10px 12px",
    borderRadius: 8,
    border: "1px solid #d1d5db",
  },
  button: {
    padding: "10px 14px",
    borderRadius: 8,
    border: "1px solid #374151",
    background: "#111827",
    color: "#ffffff",
    cursor: "pointer",
  },
  sectionTitle: {
    marginTop: 16,
    marginBottom: 8,
    fontWeight: 600,
  },
  list: {
    margin: 0,
    paddingLeft: 20,
  },
  panel: {
    border: "1px solid #e5e7eb",
    borderRadius: 8,
    padding: 10,
    background: "#fafafa",
    maxHeight: 180,
    overflowY: "auto",
  },
  videoGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
    gap: 10,
    marginTop: 12,
  },
  videoCard: {
    border: "1px solid #e5e7eb",
    borderRadius: 8,
    padding: 8,
    background: "#fafafa",
  },
  video: {
    width: "100%",
    height: 180,
    background: "#111827",
    borderRadius: 8,
    objectFit: "cover",
  },
  label: {
    marginBottom: 6,
    fontWeight: 600,
  },
  statusConnected: {
    color: "#047857",
    fontWeight: 600,
  },
  statusConnecting: {
    color: "#b45309",
    fontWeight: 600,
  },
  statusDisconnected: {
    color: "#b91c1c",
    fontWeight: 600,
  },
};

export default function Home() {
  const socketRef = useRef(null);
  const peerRef = useRef(null);
  const localStreamRef = useRef(null);
  const pendingCandidatesRef = useRef([]);
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);

  const [currentUser, setCurrentUser] = useState(USER_A);
  const [connectionStatus, setConnectionStatus] = useState("disconnected");
  const [messageInput, setMessageInput] = useState("");
  const [messages, setMessages] = useState([]);
  const [statusLogs, setStatusLogs] = useState([]);
  const [mediaStatus, setMediaStatus] = useState("not-started");
  const [callStatus, setCallStatus] = useState("idle");

  const roomId = useMemo(() => [USER_A, USER_B].sort().join("_"), []);
  const otherUser = currentUser === USER_A ? USER_B : USER_A;

  const addStatusLog = (text) => {
    const stamped = `${new Date().toLocaleTimeString()} - ${text}`;
    console.log("UI Status:", stamped);
    setStatusLogs((prev) => [stamped, ...prev].slice(0, 80));
  };

  const statusStyle =
    connectionStatus === "connected"
      ? styles.statusConnected
      : connectionStatus === "connecting"
        ? styles.statusConnecting
        : styles.statusDisconnected;

  const sendSignal = (payload) => {
    const ws = socketRef.current;

    if (!ws || ws.readyState !== WebSocket.OPEN) {
      addStatusLog("Signal not sent: socket is not connected");
      return;
    }

    const signalMessage = {
      kind: "webrtc-signal",
      roomId,
      from: currentUser,
      to: otherUser,
      ...payload,
      ts: Date.now(),
    };

    ws.send(JSON.stringify(signalMessage));
    addStatusLog(`Signal sent: ${payload.signalType}`);
  };

  const closePeerConnection = () => {
    if (peerRef.current) {
      peerRef.current.onicecandidate = null;
      peerRef.current.ontrack = null;
      peerRef.current.onconnectionstatechange = null;
      peerRef.current.close();
      peerRef.current = null;
    }

    pendingCandidatesRef.current = [];

    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }

    setCallStatus("idle");
  };

  const flushPendingCandidates = async (pc) => {
    if (!pendingCandidatesRef.current.length) {
      return;
    }

    const queued = [...pendingCandidatesRef.current];
    pendingCandidatesRef.current = [];

    for (const candidate of queued) {
      try {
        await pc.addIceCandidate(candidate);
      } catch (error) {
        addStatusLog(`Failed queued ICE candidate: ${String(error)}`);
      }
    }
  };

  const createPeerConnection = () => {
    closePeerConnection();

    const pc = new RTCPeerConnection(RTC_CONFIG);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignal({ signalType: "ice-candidate", candidate: event.candidate });
      }
    };

    pc.ontrack = (event) => {
      const [remoteStream] = event.streams;
      if (remoteVideoRef.current && remoteStream) {
        remoteVideoRef.current.srcObject = remoteStream;
      }
      setCallStatus("connected");
      addStatusLog("Remote track received");
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      addStatusLog(`Peer state: ${state}`);
      if (
        state === "failed" ||
        state === "disconnected" ||
        state === "closed"
      ) {
        setCallStatus("idle");
      }
    };

    if (localStreamRef.current) {
      for (const track of localStreamRef.current.getTracks()) {
        pc.addTrack(track, localStreamRef.current);
      }
    }

    peerRef.current = pc;
    return pc;
  };

  const ensureLocalMedia = async () => {
    if (localStreamRef.current) {
      return localStreamRef.current;
    }

    if (!navigator?.mediaDevices?.getUserMedia) {
      if (typeof window !== "undefined" && !window.isSecureContext) {
        throw new Error(
          "getUserMedia requires HTTPS or localhost. Open frontend on http://localhost:3000, or run frontend over HTTPS for LAN access.",
        );
      }

      throw new Error("getUserMedia is not available in this browser");
    }

    setMediaStatus("requesting");
    addStatusLog("Requesting camera and microphone");

    const stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });

    localStreamRef.current = stream;
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = stream;
    }

    setMediaStatus("ready");
    addStatusLog("Local media ready");
    return stream;
  };

  const startMedia = async () => {
    try {
      await ensureLocalMedia();
    } catch (error) {
      setMediaStatus("error");
      addStatusLog(`Media error: ${formatMediaError(error)}`);
    }
  };

  const startCall = async () => {
    addStatusLog("Start Call clicked");

    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      addStatusLog("Cannot start call: connect WebSocket first");
      return;
    }

    try {
      await ensureLocalMedia();

      const pc = createPeerConnection();
      setCallStatus("calling");

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      sendSignal({ signalType: "offer", sdp: offer.sdp });
      addStatusLog("Offer created and sent");
    } catch (error) {
      setCallStatus("idle");
      addStatusLog(`Start call failed: ${formatMediaError(error)}`);
    }
  };

  const hangUp = (shouldSignal) => {
    addStatusLog("Hang Up clicked");

    if (shouldSignal) {
      sendSignal({ signalType: "hangup" });
    }

    closePeerConnection();
  };

  const handleSignalMessage = async (signal) => {
    if (signal.to && signal.to !== currentUser) {
      return;
    }

    addStatusLog(
      `Signal received: ${signal.signalType} from ${signal.from || "unknown"}`,
    );

    if (signal.signalType === "hangup") {
      closePeerConnection();
      addStatusLog("Remote hung up");
      return;
    }

    try {
      let pc = peerRef.current;

      if (signal.signalType === "offer") {
        await ensureLocalMedia();
        pc = createPeerConnection();
        setCallStatus("connecting");

        await pc.setRemoteDescription({ type: "offer", sdp: signal.sdp });
        await flushPendingCandidates(pc);

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendSignal({ signalType: "answer", sdp: answer.sdp });
        addStatusLog("Answer created and sent");
        return;
      }

      if (!pc) {
        addStatusLog("Signal ignored: no active peer connection");
        return;
      }

      if (signal.signalType === "answer") {
        await pc.setRemoteDescription({ type: "answer", sdp: signal.sdp });
        await flushPendingCandidates(pc);
        setCallStatus("connecting");
        addStatusLog("Remote answer applied");
        return;
      }

      if (signal.signalType === "ice-candidate") {
        const candidate = new RTCIceCandidate(signal.candidate);

        if (!pc.remoteDescription) {
          pendingCandidatesRef.current.push(candidate);
          addStatusLog("ICE candidate queued until remote description is set");
          return;
        }

        await pc.addIceCandidate(candidate);
        addStatusLog("ICE candidate applied");
      }
    } catch (error) {
      addStatusLog(`Signal handling error: ${String(error)}`);
    }
  };

  const connect = () => {
    addStatusLog("Connect button clicked");

    if (socketRef.current) {
      addStatusLog("Closing previous socket before reconnecting");
      socketRef.current.close();
    }

    setConnectionStatus("connecting");

    let ws;
    let wsUrl;

    try {
      wsUrl = buildWebSocketUrl(
        "https://lettucee-be.mittulabs.workers.dev/",
        roomId,
      );
      addStatusLog(`Opening socket: ${wsUrl}`);
      ws = new WebSocket(wsUrl);
    } catch (error) {
      setConnectionStatus("disconnected");
      addStatusLog(`Failed to create socket: ${String(error)}`);
      return;
    }

    ws.onopen = () => {
      setConnectionStatus("connected");
      addStatusLog("WebSocket connected");
    };

    ws.onmessage = (event) => {
      const incoming = String(event.data);
      console.log("Incoming WebSocket message:", incoming);

      try {
        const parsed = JSON.parse(incoming);
        if (parsed?.kind === "webrtc-signal") {
          handleSignalMessage(parsed);
          return;
        }
      } catch {
        // Keep plain text messages supported for quick tests.
      }

      addStatusLog(`Incoming text message: ${incoming}`);
      setMessages((prev) => [incoming, ...prev]);
    };

    ws.onerror = (error) => {
      console.log("WebSocket error:", error);
      addStatusLog("WebSocket error occurred (check browser console/network)");
    };

    ws.onclose = () => {
      setConnectionStatus("disconnected");
      addStatusLog("WebSocket disconnected");
      socketRef.current = null;
    };

    socketRef.current = ws;
  };

  const sendMessage = () => {
    addStatusLog("Send button clicked");

    const ws = socketRef.current;
    const text = messageInput.trim();

    if (!text) {
      addStatusLog("Send canceled: message is empty");
      return;
    }

    if (!ws) {
      addStatusLog("Send canceled: socket not created yet");
      return;
    }

    if (ws.readyState !== WebSocket.OPEN) {
      addStatusLog(
        `Send canceled: socket not open (readyState ${ws.readyState})`,
      );
      return;
    }

    ws.send(text);
    addStatusLog(`Sent message: ${text}`);
    setMessageInput("");
  };

  useEffect(() => {
    return () => {
      if (socketRef.current) {
        socketRef.current.close();
      }

      closePeerConnection();

      if (localStreamRef.current) {
        for (const track of localStreamRef.current.getTracks()) {
          track.stop();
        }
        localStreamRef.current = null;
      }
    };
  }, []);

  return (
    <main style={styles.page}>
      <div style={styles.card}>
        <h2>Realtime Room (WebSocket)</h2>
        <div style={styles.row}>
          <span>User:</span>
          <button
            type="button"
            onClick={() => setCurrentUser(USER_A)}
            style={styles.button}
          >
            Use A
          </button>
          <button
            type="button"
            onClick={() => setCurrentUser(USER_B)}
            style={styles.button}
          >
            Use B
          </button>
        </div>
        <p>
          Users: {USER_A}, {USER_B} (You are: {currentUser}, peer: {otherUser})
        </p>
        <p>Room ID: {roomId}</p>
        <p>
          Status: <span style={statusStyle}>{connectionStatus}</span>
        </p>
        <p>Media: {mediaStatus}</p>
        <p>Call: {callStatus}</p>

        <div style={styles.row}>
          <button type="button" onClick={connect} style={styles.button}>
            Connect
          </button>
          <button type="button" onClick={startMedia} style={styles.button}>
            Start Media
          </button>
          <button type="button" onClick={startCall} style={styles.button}>
            Start Call
          </button>
          <button
            type="button"
            onClick={() => hangUp(true)}
            style={styles.button}
          >
            Hang Up
          </button>
        </div>

        <div style={styles.videoGrid}>
          <div style={styles.videoCard}>
            <p style={styles.label}>Local</p>
            <video
              ref={localVideoRef}
              style={styles.video}
              autoPlay
              playsInline
              muted
            />
          </div>
          <div style={styles.videoCard}>
            <p style={styles.label}>Remote</p>
            <video
              ref={remoteVideoRef}
              style={styles.video}
              autoPlay
              playsInline
            />
          </div>
        </div>

        <div style={{ ...styles.row, marginTop: 12 }}>
          <input
            style={styles.input}
            value={messageInput}
            onChange={(e) => setMessageInput(e.target.value)}
            placeholder="Type a message"
          />
          <button type="button" onClick={sendMessage} style={styles.button}>
            Send
          </button>
        </div>

        <p style={styles.sectionTitle}>Received Messages</p>
        <div style={styles.panel}>
          {messages.length === 0 ? (
            <p>No messages yet</p>
          ) : (
            <ul style={styles.list}>
              {messages.map((msg, index) => (
                <li key={`${msg}-${index}`}>{msg}</li>
              ))}
            </ul>
          )}
        </div>

        <p style={styles.sectionTitle}>Status Logs</p>
        <div style={styles.panel}>
          {statusLogs.length === 0 ? (
            <p>No events yet. Click Connect to begin.</p>
          ) : (
            <ul style={styles.list}>
              {statusLogs.map((log, index) => (
                <li key={`${log}-${index}`}>{log}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </main>
  );
}
