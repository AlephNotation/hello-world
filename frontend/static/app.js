"use strict";

const form = document.querySelector("#note-form");
const bodyInput = document.querySelector("#note-body");
const saveButton = document.querySelector("#save-note");
const feedback = document.querySelector("#note-feedback");
const notesList = document.querySelector("#notes-list");
const emptyState = document.querySelector("#notes-empty");
const retryButton = document.querySelector("#retry-connection");
let loadingState = false;
let refreshQueued = false;
let hasLoaded = false;
let saving = false;
let saveNeedsConnection = false;

function showFeedback(message, error = false) {
  feedback.textContent = message;
  feedback.classList.toggle("error", error);
}

async function request(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(path, {
      ...options,
      signal: controller.signal,
      cache: "no-store",
      headers: { Accept: "application/json", ...options.headers },
    });
    if (!response.ok) {
      const error = new Error(`Request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function renderNotes(notes, total) {
  notesList.replaceChildren();
  document.querySelector("#note-count").textContent = `${total} ${total === 1 ? "note" : "notes"}`;
  for (const note of notes) {
    const item = document.createElement("li");
    item.className = "note-item";
    const text = document.createElement("p");
    text.className = "note-text";
    text.textContent = note.body;
    const time = document.createElement("time");
    time.className = "note-time";
    time.dateTime = note.created_at;
    const date = new Date(note.created_at);
    time.textContent = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    time.title = date.toLocaleString();
    item.append(text, time);
    notesList.append(item);
  }
  notesList.hidden = notes.length === 0;
  emptyState.hidden = notes.length !== 0;
  emptyState.textContent = "A fresh notebook. Leave the first note.";
}

function setDisconnected() {
  document.querySelector("#database-indicator").className = "status-dot status-disconnected";
  document.querySelector("#database-status").textContent = "Connection unavailable";
  document.querySelector("#database-latency").textContent = "—";
  document.querySelector("#database-instance").textContent = "—";
  document.querySelector("#database-instance").removeAttribute("title");
  document.querySelector("#connection-message").textContent = hasLoaded
    ? "The last connection check failed. Displayed notes are from the last successful check."
    : "We couldn’t reach the database. Check that both machines are running and the frontend has its database connection configured.";
  retryButton.hidden = false;
  if (!hasLoaded) {
    emptyState.hidden = false;
    emptyState.textContent = "The notebook is unavailable until the database reconnects.";
  }
}

async function refreshState() {
  if (loadingState) {
    refreshQueued = true;
    return;
  }
  loadingState = true;
  retryButton.disabled = true;
  try {
    const state = await request("/api/state");
    if (state.database?.status !== "connected" || !Array.isArray(state.notes)) {
      throw new Error("Database did not confirm a healthy connection");
    }
    document.querySelector("#database-indicator").className = "status-dot status-connected";
    document.querySelector("#database-status").textContent = "Postgres connected";
    document.querySelector("#database-latency").textContent = `${state.database.latency_ms} ms`;
    const instance = document.querySelector("#database-instance");
    const instanceId = String(state.database.instance_id);
    instance.textContent = instanceId.length > 14 ? `${instanceId.slice(0, 12)}…` : instanceId;
    instance.title = instanceId;
    document.querySelector("#connection-message").textContent = "A real database query succeeded. Checked every 15 seconds while this page is visible.";
    retryButton.hidden = true;
    renderNotes(state.notes, state.total_notes);
    hasLoaded = true;
    if (saveNeedsConnection) {
      showFeedback("Database reconnected. Your draft is ready to save.");
      saveNeedsConnection = false;
    }
  } catch {
    setDisconnected();
  } finally {
    loadingState = false;
    retryButton.disabled = false;
    if (refreshQueued) {
      refreshQueued = false;
      refreshState();
    }
  }
}

bodyInput.addEventListener("input", () => {
  document.querySelector("#character-count").textContent = `${Array.from(bodyInput.value).length} / 180`;
  bodyInput.setCustomValidity("");
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (saving) return;
  const body = bodyInput.value.trim();
  if (body.length === 0) {
    bodyInput.setCustomValidity("Write a little something before saving.");
    bodyInput.reportValidity();
    return;
  }
  if (Array.from(body).length > 180) {
    bodyInput.setCustomValidity("Keep your note to 180 characters or fewer.");
    bodyInput.reportValidity();
    return;
  }
  const submittedDraft = bodyInput.value;
  saving = true;
  saveNeedsConnection = false;
  saveButton.disabled = true;
  saveButton.textContent = "Saving…";
  showFeedback("Writing your note to Postgres…");
  try {
    await request("/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
    if (bodyInput.value === submittedDraft) {
      bodyInput.value = "";
      document.querySelector("#character-count").textContent = "0 / 180";
    }
    showFeedback("Saved to Postgres. Try refreshing the page.");
    await refreshState();
  } catch (error) {
    if (error.status === 503) {
      setDisconnected();
      saveNeedsConnection = true;
      showFeedback("The database is unavailable. Your draft is still here; reconnect and try again.", true);
    } else if (error.status === 422 || error.status === 400) {
      showFeedback("Use between 1 and 180 characters for your note. Your draft is still here.", true);
    } else {
      showFeedback("We couldn’t confirm the save. Your draft is still here. Check the recent notes before trying again.", true);
      await refreshState();
    }
  } finally {
    saving = false;
    saveButton.disabled = false;
    saveButton.textContent = "Save to Postgres ";
    const arrow = document.createElement("span");
    arrow.setAttribute("aria-hidden", "true");
    arrow.textContent = "↗";
    saveButton.append(arrow);
  }
});

retryButton.addEventListener("click", refreshState);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshState();
});
setInterval(() => {
  if (!document.hidden && !saving) refreshState();
}, 15000);
refreshState();

for (const button of document.querySelectorAll(".copy-button")) {
  button.addEventListener("click", async () => {
    const command = document.getElementById(button.dataset.copy);
    const copyFeedback = document.querySelector("#copy-feedback");
    try {
      await navigator.clipboard.writeText(command.textContent);
      button.classList.add("copied");
      button.title = "Copied";
      copyFeedback.textContent = "Command copied to clipboard.";
      setTimeout(() => {
        button.classList.remove("copied");
        button.removeAttribute("title");
      }, 2000);
    } catch {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(command);
      selection.removeAllRanges();
      selection.addRange(range);
      copyFeedback.textContent = "Automatic copying isn’t available here. The command is selected; use your keyboard’s copy shortcut.";
      button.title = "Command selected — press your copy shortcut";
    }
  });
}
