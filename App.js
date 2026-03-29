import React, { useMemo, useRef, useState } from "react";
import {
  Button,
  FlatList,
  SafeAreaView,
  Text,
  TextInput,
  View,
} from "react-native";

const USER_A = "A";
const USER_B = "B";
const WORKER_URL = "http://192.168.0.7:8787/";

export default function App() {
  const socketRef = useRef(null);
  const [connectionStatus, setConnectionStatus] = useState("disconnected");
  const [messageInput, setMessageInput] = useState("");
  const [messages, setMessages] = useState([]);

  const roomId = useMemo(() => [USER_A, USER_B].sort().join("_"), []);

  const connect = () => {
    if (socketRef.current) {
      socketRef.current.close();
    }

    setConnectionStatus("connecting");

    const ws = new WebSocket(`wss://${WORKER_URL}/room/${roomId}`);

    ws.onopen = () => {
      setConnectionStatus("connected");
    };

    ws.onmessage = (event) => {
      const incoming = String(event.data);
      console.log("Incoming WebSocket message:", incoming);
      setMessages((prev) => [incoming, ...prev]);
    };

    ws.onerror = (error) => {
      console.log("WebSocket error:", error?.message || error);
    };

    ws.onclose = () => {
      setConnectionStatus("disconnected");
      socketRef.current = null;
    };

    socketRef.current = ws;
  };

  const sendMessage = () => {
    const ws = socketRef.current;
    const text = messageInput.trim();

    if (!ws || ws.readyState !== WebSocket.OPEN || !text) {
      return;
    }

    ws.send(text);
    setMessages((prev) => [`You: ${text}`, ...prev]);
    setMessageInput("");
  };

  return (
    <SafeAreaView>
      <View>
        <Text>
          Users: {USER_A}, {USER_B}
        </Text>
        <Text>Room ID: {roomId}</Text>
        <Text>Status: {connectionStatus}</Text>
        <Button title="Connect" onPress={connect} />

        <TextInput
          value={messageInput}
          onChangeText={setMessageInput}
          placeholder="Type a message"
        />
        <Button title="Send" onPress={sendMessage} />

        <FlatList
          data={messages}
          keyExtractor={(_, index) => String(index)}
          renderItem={({ item }) => <Text>{item}</Text>}
        />
      </View>
    </SafeAreaView>
  );
}
