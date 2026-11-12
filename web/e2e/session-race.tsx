import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { useChatSession } from "../src/chat/useChatSession";
function Harness() {
  const [sid, setSid] = useState<string | undefined>("A");
  const chat = useChatSession(sid);
  return (
    <>
      <button onClick={() => setSid("A")}>A</button>
      <button onClick={() => setSid("B")}>B</button>
      <button onClick={() => setSid(undefined)}>logout</button>
      <button onClick={() => void chat.loadOlder()}>older</button>
      <output>
        {JSON.stringify({
          sid,
          items: chat.projection.items,
          error: chat.error,
          hasOlder: chat.hasOlder,
        })}
      </output>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Harness />);
