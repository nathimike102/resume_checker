const request = async (path, body) => {
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
};

// A browser-local id is the whole of our "session". No accounts, by choice.
export function sessionId() {
  let id = localStorage.getItem('fit_session');
  if (!id) {
    id = `web-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem('fit_session', id);
  }
  return id;
}

export const health = () => request('/api/health');
export const sendChat = (payload) => request('/api/chat', { session_id: sessionId(), ...payload });
export const match = (resumeText, jdText) => request('/api/match', { resume_text: resumeText, jd_text: jdText });
export const matrix = (resumes, jds) => request('/api/matrix', { resumes, jds });
export const runEval = () => request('/api/eval');

/** Files go up as base64 in JSON — one request shape for text and uploads. */
export function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ file: String(reader.result).split(',')[1], filename: file.name });
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
