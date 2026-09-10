import { useEffect, useRef, useState } from 'react';
import { sendChat, readFileAsBase64 } from '../api.js';

export default function Chat({ onResult }) {
  const [messages, setMessages] = useState([
    { from: 'bot', text: 'Send me your resume — paste the text or attach a PDF/DOCX. Then send a job description.' },
  ]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef(null);

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [messages]);

  async function send(payload, label) {
    setMessages((m) => [...m, { from: 'me', text: label }]);
    setBusy(true);
    try {
      const reply = await sendChat(payload);
      setMessages((m) => [...m, { from: 'bot', text: reply.text }]);
      if (reply.result) onResult(reply.result);
    } catch (error) {
      setMessages((m) => [...m, { from: 'bot', text: `Error: ${error.message}` }]);
    } finally {
      setBusy(false);
    }
  }

  const submit = (event) => {
    event.preventDefault();
    if (!draft.trim() || busy) return;
    const text = draft;
    setDraft('');
    send({ text }, text.length > 220 ? `${text.slice(0, 200)}…  (${text.length} chars)` : text);
  };

  const attach = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    event.target.value = '';
    send(await readFileAsBase64(file), `📎 ${file.name}`);
  };

  return (
    <div className="chat">
      <div className="chat-log">
        {messages.map((message, i) => (
          <div key={i} className={`bubble bubble-${message.from}`}>{message.text}</div>
        ))}
        {busy && <div className="bubble bubble-bot muted">thinking…</div>}
        <div ref={endRef} />
      </div>
      <form className="chat-input" onSubmit={submit}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(e); }}
          placeholder="Paste resume or job description text…  (Ctrl+Enter to send)"
          rows={3}
        />
        <div className="chat-actions">
          <label className="attach">
            attach
            <input type="file" accept=".pdf,.docx,.txt,.md" onChange={attach} hidden />
          </label>
          <button type="submit" disabled={busy || !draft.trim()}>Send</button>
        </div>
      </form>
    </div>
  );
}
