"use strict";

const api = globalThis.browser ?? globalThis.chrome;

const SOURCE_BASE =
  "https:" + "//raw.githubusercontent.com/Fengsemul/2/main/";

const SOURCE_FILES = Object.freeze([
  "1.txt",
  "2.txt",
  "3.txt",
  "4.txt",
  "5.txt",
  "6.txt",
  "7.txt",
  "8.txt",
  "9.txt",
  "a.txt",
  "b.txt",
  "c.txt",
  "cdn",
  "d.txt",
  "e.txt",
  "f.txt",
  "g.txt"
]);

const SOURCE_URLS = Object.freeze(
  SOURCE_FILES.map((name) => SOURCE_BASE + name)
);

const IMPORT_BATCH_SIZE = 2000;
const MAX_LINE_LENGTH = 1048576;
const MAX_LABEL_LENGTH = 63;

const indexStatusOutput =
  document.querySelector("#index-status");
const domainCountOutput =
  document.querySelector("#domain-count");
const generationOutput =
  document.querySelector("#generation");
const importedAtOutput =
  document.querySelector("#imported-at");
const sourceCountOutput =
  document.querySelector("#source-count");
const enabledInput =
  document.querySelector("#enabled");
const includeSubdomainsInput =
  document.querySelector("#include-subdomains");
const startImportButton =
  document.querySelector("#start-import");
const resumeImportButton =
  document.querySelector("#resume-import");
const abandonImportButton =
  document.querySelector("#abandon-import");
const clearDataButton =
  document.querySelector("#clear-data");
const progressElement =
  document.querySelector("#progress");
const progressTextOutput =
  document.querySelector("#progress-text");

let importRunning = false;
let cancellationRequested = false;
let activeImportId = null;
let activeFetchController = null;
let savedImportState = null;

function formatInteger(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return "-";
  }

  return new Intl.NumberFormat().format(number);
}

function formatDate(value) {
  if (!value) {
    return "-";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return date.toLocaleString();
}

function errorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function createImportId() {
  if (
    globalThis.crypto &&
    typeof globalThis.crypto.randomUUID === "function"
  ) {
    return globalThis.crypto
      .randomUUID()
      .replaceAll("-", "");
  }

  return (
    Date.now().toString(36) +
    Math.random().toString(36).slice(2) +
    Math.random().toString(36).slice(2)
  );
}

function sourceConfigurationMatches(importState) {
  if (!importState) {
    return false;
  }

  if (
    importState.expectedSourceCount !==
    SOURCE_FILES.length
  ) {
    return false;
  }

  if (!Array.isArray(importState.sourceNames)) {
    return false;
  }

  return (
    JSON.stringify(importState.sourceNames) ===
    JSON.stringify(SOURCE_FILES)
  );
}

function setControls() {
  const resumable =
    !importRunning &&
    savedImportState?.status === "building";

  startImportButton.disabled =
    importRunning || resumable;

  resumeImportButton.disabled =
    importRunning || !resumable;

  abandonImportButton.disabled =

    !importRunning && !resumable;

  abandonImportButton.textContent =

    importRunning

      ? "Pause import"

      : resumable

        ? "Discard unfinished build"

        : "Pause import";

  clearDataButton.disabled =
    importRunning || resumable;

  enabledInput.disabled = importRunning;

  if (includeSubdomainsInput) {
    includeSubdomainsInput.checked = true;
    includeSubdomainsInput.disabled = true;
  }
}

function displayStatus(status) {
  const active = status?.active === true;

  savedImportState =
    status?.resumableImport === true
      ? status.importState
      : null;

  enabledInput.checked =
    status?.enabled !== false;

  if (includeSubdomainsInput) {
    includeSubdomainsInput.checked = true;
    includeSubdomainsInput.disabled = true;
  }

  if (importRunning) {
    indexStatusOutput.textContent = active
      ? "Updating label index; existing index remains active"
      : "Building label index";
  } else if (savedImportState) {
    const completed = Number(
      savedImportState.completedSources ?? 0
    );

    indexStatusOutput.textContent =
      "Resumable build: " +
      completed +
      " of " +
      SOURCE_FILES.length +
      " sources completed";
  } else if (active) {
    indexStatusOutput.textContent =
      "Active full label index";
  } else {
    indexStatusOutput.textContent =
      "No active label index";
  }

  domainCountOutput.textContent =
    formatInteger(status?.count ?? 0);

  generationOutput.textContent =
    formatInteger(status?.generation ?? 0);

  importedAtOutput.textContent =
    formatDate(status?.importedAt);

  sourceCountOutput.textContent =
    formatInteger(SOURCE_FILES.length);

  if (savedImportState) {
    const nextSource = Math.min(
      Number(savedImportState.completedSources ?? 0) + 1,
      SOURCE_FILES.length
    );

    progressElement.hidden = false;
    progressElement.max = SOURCE_FILES.length;
    progressElement.value = Number(
      savedImportState.completedSources ?? 0
    );

    if (sourceConfigurationMatches(savedImportState)) {
      progressTextOutput.textContent =
        "An interrupted build can resume at source " +
        nextSource +
        " of " +
        SOURCE_FILES.length +
        " (" +
        SOURCE_FILES[nextSource - 1] +
        "). The interrupted source will restart safely.";
    } else {
      progressTextOutput.textContent =
        "The saved build uses a different source list. " +
        "Abandon it before starting a new import.";
    }
  }

  setControls();
}

async function refreshStatus() {
  const status = await api.runtime.sendMessage({
    type: "get-status"
  });

  displayStatus(status);
  return status;
}

async function saveSettings() {
  const status = await api.runtime.sendMessage({
    type: "set-settings",
    enabled: enabledInput.checked
  });

  displayStatus(status);
}

function normalizeLabel(value) {
  let label = String(value)
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase();

  if (
    !label ||
    label.startsWith("#") ||
    label.startsWith("!") ||
    label.includes("\u0000")
  ) {
    return "";
  }

  const fields = label.split(/\s+/);

  if (
    fields.length >= 2 &&
    /^(?:0\.0\.0\.0|127\.0\.0\.1|::1)$/.test(
      fields[0]
    )
  ) {
    label = fields[1];
  } else {
    label = fields[0];
  }

  if (!label || label.startsWith("@@")) {
    return "";
  }

  if (label.startsWith("*://*.")) {
    label = label.slice(6);
  } else if (label.startsWith("*://")) {
    label = label.slice(4);
    label = label.replace(/^\*\./, "");
  }

  if (label.endsWith("/*")) {
    label = label.slice(0, -2);
  }

  label = label
    .replace(/^\.+/, "")
    .replace(/\.+$/, "");

  if (
    label.includes("/") ||
    label.includes("\\") ||
    label.includes(":") ||
    label.includes("?") ||
    label.includes("#") ||
    label.includes("*") ||
    label.includes("|") ||
    label.includes("^") ||
    label.includes(".")
  ) {
    return "";
  }

  if (
    label.length === 0 ||
    label.length > MAX_LABEL_LENGTH
  ) {
    return "";
  }

  if (
    !/^[a-z0-9_-]+$/.test(label) ||
    label.startsWith("-") ||
    label.endsWith("-")
  ) {
    return "";
  }

  return label;
}

function throwIfCancelled() {
  if (cancellationRequested) {
    throw new DOMException(
      "Import paused.",
      "AbortError"
    );
  }
}

async function streamResponseLines(
  response,
  onLine
) {
  if (!response.body) {
    const text = await response.text();

    for (const line of text.split(/\r?\n/)) {
      throwIfCancelled();
      await onLine(line);
    }

    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", {
    fatal: false
  });

  let remainder = "";

  try {
    while (true) {
      throwIfCancelled();

      const part = await reader.read();

      if (part.done) {
        break;
      }

      remainder += decoder.decode(part.value, {
        stream: true
      });

      let lineStart = 0;

      for (
        let index = 0;
        index < remainder.length;
        index++
      ) {
        if (remainder.charCodeAt(index) !== 10) {
          continue;
        }

        let line = remainder.slice(
          lineStart,
          index
        );

        if (line.endsWith("\r")) {
          line = line.slice(0, -1);
        }

        await onLine(line);
        lineStart = index + 1;
      }

      remainder = remainder.slice(lineStart);

      if (remainder.length > MAX_LINE_LENGTH) {
        throw new Error(
          "A source contains a line larger than 1 MiB."
        );
      }
    }

    remainder += decoder.decode();

    if (remainder.length > 0) {
      if (remainder.endsWith("\r")) {
        remainder = remainder.slice(0, -1);
      }

      await onLine(remainder);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The stream may already be closed.
    }
  }
}

function updateProgress(
  phase,
  sourceIndex,
  totals,
  detail = ""
) {
  progressElement.hidden = false;
  progressElement.max = SOURCE_FILES.length;

  if (phase === "complete") {
    progressElement.value = SOURCE_FILES.length;
  } else {
    progressElement.value = Math.min(
      Math.max(sourceIndex - 1, 0),
      SOURCE_FILES.length
    );
  }

  const lines = formatInteger(totals.lines);
  const accepted =
    formatInteger(totals.accepted);
  const rejected =
    formatInteger(totals.rejected);

  switch (phase) {
    case "preparing":
      progressTextOutput.textContent =
        "Preparing a new resumable label index...";
      break;

    case "resuming":
      progressTextOutput.textContent =
        "Resuming at source " +
        sourceIndex +
        " of " +
        SOURCE_FILES.length +
        ". The interrupted source is being restarted.";
      break;

    case "downloading":
      progressTextOutput.textContent =
        "Downloading " +
        SOURCE_FILES[sourceIndex - 1] +
        " - source " +
        sourceIndex +
        " of " +
        SOURCE_FILES.length +
        ". This session has read " +
        lines +
        " lines.";
      break;

    case "importing":
      progressTextOutput.textContent =
        "Importing " +
        SOURCE_FILES[sourceIndex - 1] +
        " - source " +
        sourceIndex +
        " of " +
        SOURCE_FILES.length +
        ". This session: " +
        accepted +
        " valid labels; " +
        rejected +
        " rejected lines.";
      break;

    case "activating":
      progressElement.value = SOURCE_FILES.length;
      progressTextOutput.textContent =
        "All sources completed. Counting and activating the label index...";
      break;

    case "paused":
      progressTextOutput.textContent =
        "Import paused. Reopen this page and use Resume import.";
      break;

    case "complete":
      progressTextOutput.textContent =
        detail || "Label import completed.";
      break;

    case "failed":
      progressTextOutput.textContent =
        "Import paused after an error: " +
        detail +
        " Use Resume import to retry the current source.";
      break;

    default:
      progressTextOutput.textContent =
        detail || "Import is running...";
  }
}

async function sendImportBatch(
  importId,
  sourceIndex,
  labels
) {
  throwIfCancelled();

  const response = await api.runtime.sendMessage({
    type: "append-import-batch",
    importId,
    sourceIndex,
    labels
  });

  if (!response) {
    throw new Error(
      "The background process returned no batch response."
    );
  }
}

async function importSource(
  importId,
  sourceIndex,
  sourceUrl,
  totals
) {
  throwIfCancelled();

  updateProgress(
    "downloading",
    sourceIndex,
    totals
  );

  activeFetchController = new AbortController();

  try {
    const response = await fetch(sourceUrl, {
      cache: "no-store",
      credentials: "omit",
      redirect: "follow",
      signal: activeFetchController.signal
    });

    if (!response.ok) {
      throw new Error(
        "Download failed with HTTP " +
        response.status +
        ": " +
        sourceUrl
      );
    }

    let batchSet = new Set();

    async function flushBatch() {
      if (batchSet.size === 0) {
        return;
      }

      throwIfCancelled();

      const labels = Array.from(batchSet);
      batchSet = new Set();

      await sendImportBatch(
        importId,
        sourceIndex,
        labels
      );

      updateProgress(
        "importing",
        sourceIndex,
        totals
      );

      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    }

    await streamResponseLines(
      response,
      async (line) => {
        throwIfCancelled();

        totals.lines++;

        const label = normalizeLabel(line);

        if (!label) {
          totals.rejected++;
          return;
        }

        totals.accepted++;
        batchSet.add(label);

        if (
          batchSet.size >= IMPORT_BATCH_SIZE
        ) {
          await flushBatch();
        }
      }
    );

    await flushBatch();
  } finally {
    activeFetchController = null;
  }

  await api.runtime.sendMessage({
    type: "complete-import-source",
    importId,
    sourceIndex
  });

  progressElement.value = sourceIndex;
}

async function runRemainingSources(
  importId,
  startSourceIndex
) {
  const totals = {
    lines: 0,
    accepted: 0,
    rejected: 0
  };

  for (
    let index = startSourceIndex - 1;
    index < SOURCE_URLS.length;
    index++
  ) {
    await importSource(
      importId,
      index + 1,
      SOURCE_URLS[index],
      totals
    );
  }

  throwIfCancelled();

  updateProgress(
    "activating",
    SOURCE_FILES.length,
    totals
  );

  const result = await api.runtime.sendMessage({
    type: "finish-import",
    importId
  });

  const exactCount =
    result?.exactCount ??
    result?.count ??
    0;

  updateProgress(
    "complete",
    SOURCE_FILES.length,
    totals,
    "Import complete. The active index contains " +
      formatInteger(exactCount) +
      " exact hostname labels."
  );

  await refreshStatus();
}

async function startNewImport() {
  if (importRunning || savedImportState) {
    return;
  }

  const confirmed = globalThis.confirm(
    "Start a new import of all 17 label files? " +
      "Files are processed sequentially. " +
      "If Firefox or Windows closes, reopen this page and resume."
  );

  if (!confirmed) {
    return;
  }

  importRunning = true;
  cancellationRequested = false;
  activeImportId = createImportId();
  setControls();

  const totals = {
    lines: 0,
    accepted: 0,
    rejected: 0
  };

  updateProgress("preparing", 1, totals);

  try {
    const response = await api.runtime.sendMessage({
      type: "begin-import",
      importId: activeImportId,
      expectedSourceCount: SOURCE_FILES.length,
      sourceNames: Array.from(SOURCE_FILES)
    });

    activeImportId =
      response?.importId ?? activeImportId;

    await runRemainingSources(
      activeImportId,
      1
    );
  } catch (error) {
    const paused =
      cancellationRequested ||
      error?.name === "AbortError";

    updateProgress(
      paused ? "paused" : "failed",
      Number(progressElement.value) + 1,
      totals,
      paused ? "" : errorMessage(error)
    );
  } finally {
    activeFetchController = null;
    activeImportId = null;
    cancellationRequested = false;
    importRunning = false;

    await refreshStatus().catch(
      console.error
    );
  }
}

async function resumeSavedImport() {
  if (importRunning || !savedImportState) {
    return;
  }

  if (!sourceConfigurationMatches(savedImportState)) {
    throw new Error(
      "The saved import uses a different source list. Abandon it first."
    );
  }

  const confirmed = globalThis.confirm(
    "Resume the saved build? " +
      "The interrupted source will restart from its beginning. " +
      "Previously completed sources remain stored."
  );

  if (!confirmed) {
    return;
  }

  importRunning = true;
  cancellationRequested = false;
  setControls();

  try {
    const response = await api.runtime.sendMessage({
      type: "resume-import",
      expectedSourceCount: SOURCE_FILES.length,
      sourceNames: Array.from(SOURCE_FILES)
    });

    activeImportId = response.importId;

    const nextSource = Number(
      response.nextSource ??
      response.completedSources + 1
    );

    const totals = {
      lines: 0,
      accepted: 0,
      rejected: 0
    };

    updateProgress(
      "resuming",
      nextSource,
      totals
    );

    await runRemainingSources(
      activeImportId,
      nextSource
    );
  } catch (error) {
    const paused =
      cancellationRequested ||
      error?.name === "AbortError";

    updateProgress(
      paused ? "paused" : "failed",
      Number(progressElement.value) + 1,
      {
        lines: 0,
        accepted: 0,
        rejected: 0
      },
      paused ? "" : errorMessage(error)
    );
  } finally {
    activeFetchController = null;
    activeImportId = null;
    cancellationRequested = false;
    importRunning = false;

    await refreshStatus().catch(
      console.error
    );
  }
}

async function pauseImport() {
  if (!importRunning) {
    return;
  }

  cancellationRequested = true;
  abandonImportButton.disabled = true;

  progressTextOutput.textContent =
    "Pausing after the current operation...";

  if (activeFetchController) {
    activeFetchController.abort();
  }
}

async function abandonSavedImport() {
  if (importRunning) {
    await pauseImport();
    return;
  }

  if (!savedImportState) {
    return;
  }

  const confirmed = globalThis.confirm(
    "Abandon the incomplete build? " +
      "Its database will be removed separately. " +
      "Any active completed index will remain active."
  );

  if (!confirmed) {
    return;
  }

  abandonImportButton.disabled = true;

  const response = await api.runtime.sendMessage({
    type: "abandon-import",
    importId: savedImportState.importId
  });

  progressTextOutput.textContent =
    response?.message ??
    "The incomplete build was abandoned.";

  savedImportState = null;
  await refreshStatus();
}

async function clearData() {
  if (importRunning || savedImportState) {
    throw new Error(
      "Pause and abandon the incomplete build before deleting all data."
    );
  }

  const confirmed = globalThis.confirm(
    "Delete the active hostname-label index? " +
      "Filtering will have no effect until a new import finishes."
  );

  if (!confirmed) {
    return;
  }

  clearDataButton.disabled = true;
  progressTextOutput.textContent =
    "Removing index metadata...";

  try {
    const status = await api.runtime.sendMessage({
      type: "clear-data"
    });

    progressElement.hidden = true;
    progressTextOutput.textContent =
      "The active index was removed. Its database will be deleted separately.";

    displayStatus(status);
  } finally {
    setControls();
  }
}

function warnBeforeClosing(event) {
  if (!importRunning) {
    return undefined;
  }

  event.preventDefault();
  event.returnValue = "";
  return "";
}

enabledInput.addEventListener(
  "change",
  () => {
    saveSettings().catch((error) => {
      console.error(error);
      progressTextOutput.textContent =
        "Could not save settings: " +
        errorMessage(error);
    });
  }
);

if (includeSubdomainsInput) {
  includeSubdomainsInput.checked = true;
  includeSubdomainsInput.disabled = true;
}

startImportButton.addEventListener(
  "click",
  () => {
    startNewImport().catch((error) => {
      console.error(error);
      progressTextOutput.textContent =
        "Could not start import: " +
        errorMessage(error);
      importRunning = false;
      setControls();
    });
  }
);

resumeImportButton.addEventListener(
  "click",
  () => {
    resumeSavedImport().catch((error) => {
      console.error(error);
      progressTextOutput.textContent =
        "Could not resume import: " +
        errorMessage(error);
      importRunning = false;
      setControls();
    });
  }
);

abandonImportButton.addEventListener(
  "click",
  () => {
    const operation = importRunning
      ? pauseImport()
      : abandonSavedImport();

    operation.catch((error) => {
      console.error(error);
      progressTextOutput.textContent =
        "Could not update the import: " +
        errorMessage(error);
      setControls();
    });
  }
);

clearDataButton.addEventListener(
  "click",
  () => {
    clearData().catch((error) => {
      console.error(error);
      progressTextOutput.textContent =
        "Could not delete index: " +
        errorMessage(error);
      setControls();
    });
  }
);

globalThis.addEventListener(
  "beforeunload",
  warnBeforeClosing
);

sourceCountOutput.textContent =
  formatInteger(SOURCE_FILES.length);

refreshStatus().catch((error) => {
  console.error(error);
  indexStatusOutput.textContent =
    "Could not contact the extension background process.";
  progressTextOutput.textContent =
    errorMessage(error);
  setControls();
});
