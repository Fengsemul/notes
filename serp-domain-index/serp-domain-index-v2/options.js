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
  SOURCE_FILES.map(
    (name) => SOURCE_BASE + name
  )
);

const IMPORT_BATCH_SIZE = 2000;
const MAX_LINE_LENGTH = 1024 * 1024;
const MAX_LABEL_LENGTH = 63;
const MAX_REJECTION_SAMPLES = 20;

const indexStatusOutput =
  document.querySelector("#index-status");
const labelCountOutput =
  document.querySelector("#label-count");
const activeGenerationOutput =
  document.querySelector("#active-generation");
const previousGenerationOutput =
  document.querySelector("#previous-generation");
const importedAtOutput =
  document.querySelector("#imported-at");
const sourceCountOutput =
  document.querySelector("#source-count");
const publicSuffixStatusOutput =
  document.querySelector("#psl-status");

const enabledInput =
  document.querySelector("#enabled");
const protectedLabelsInput =
  document.querySelector("#protected-labels");
const saveSettingsButton =
  document.querySelector("#save-settings");

const startImportButton =
  document.querySelector("#start-import");
const resumeImportButton =
  document.querySelector("#resume-import");
const pauseImportButton =
  document.querySelector("#pause-import");
const abandonImportButton =
  document.querySelector("#abandon-import");

const progressElement =
  document.querySelector("#progress");
const progressTextOutput =
  document.querySelector("#progress-text");
const currentSourceOutput =
  document.querySelector("#current-source");
const completedSourcesOutput =
  document.querySelector("#completed-sources");
const acceptedCountOutput =
  document.querySelector("#accepted-count");
const rejectedCountOutput =
  document.querySelector("#rejected-count");

const rejectionSummaryElement =
  document.querySelector("#rejection-summary");
const rejectionSamplesElement =
  document.querySelector("#rejection-samples");

const cleanUnusedButton =
  document.querySelector("#clean-unused");
const deletePreviousButton =
  document.querySelector("#delete-previous");
const clearDataButton =
  document.querySelector("#clear-data");
const maintenanceStatusOutput =
  document.querySelector("#maintenance-status");

let importRunning = false;
let pauseRequested = false;
let activeImportId = null;
let activeFetchController = null;
let savedImportState = null;
let latestStatus = null;

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

function setOutputStatus(
  output,
  message,
  kind = ""
) {
  output.textContent = message;
  output.classList.remove(
    "status-success",
    "status-error"
  );

  if (kind === "success") {
    output.classList.add(
      "status-success"
    );
  } else if (kind === "error") {
    output.classList.add(
      "status-error"
    );
  }
}

function createImportId() {
  if (
    globalThis.crypto &&
    typeof globalThis.crypto.randomUUID ===
      "function"
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

function sourceConfigurationMatches(
  importState
) {
  if (
    !importState ||
    importState.expectedSourceCount !==
      SOURCE_FILES.length ||
    !Array.isArray(
      importState.sourceNames
    )
  ) {
    return false;
  }

  return (
    JSON.stringify(
      importState.sourceNames
    ) ===
    JSON.stringify(SOURCE_FILES)
  );
}

function protectedLabelsFromInput() {
  const labels = new Set();

  for (
    const value of
      protectedLabelsInput.value.split(
        /\r?\n|,/
      )
  ) {
    const label = normalizeCompactLabel(
      value
    );

    if (label) {
      labels.add(label);
    }
  }

  return [...labels].sort();
}

function setControls() {
  const resumable =
    !importRunning &&
    savedImportState?.status ===
      "building";

  startImportButton.disabled =
    importRunning || resumable;

  resumeImportButton.disabled =
    importRunning ||
    !resumable ||
    !sourceConfigurationMatches(
      savedImportState
    );

  pauseImportButton.disabled =
    !importRunning;

  abandonImportButton.disabled =
    importRunning || !resumable;

  saveSettingsButton.disabled =
    importRunning;

  enabledInput.disabled =
    importRunning;

  protectedLabelsInput.disabled =
    importRunning;

  cleanUnusedButton.disabled =
    importRunning;

  deletePreviousButton.disabled =
    importRunning ||
    resumable ||
    !latestStatus?.previousGeneration;

  clearDataButton.disabled =
    importRunning || resumable;
}

function displayPublicSuffixStatus(
  publicSuffix
) {
  if (publicSuffix?.loaded !== true) {
    publicSuffixStatusOutput.textContent =
      "Not loaded";
    return;
  }

  publicSuffixStatusOutput.textContent =
    String(
      publicSuffix.version ??
      "bundled"
    ) +
    " - " +
    formatInteger(
      publicSuffix.ruleCount ?? 0
    ) +
    " rules";
}

function displayRejectedInformation(
  importState
) {
  const rejected = Number(
    importState?.rejected ?? 0
  );

  rejectedCountOutput.textContent =
    formatInteger(rejected);

  rejectionSamplesElement.replaceChildren();

  const reasons =
    importState?.rejectionReasons &&
    typeof importState.rejectionReasons ===
      "object"
      ? importState.rejectionReasons
      : {};

  const reasonEntries =
    Object.entries(reasons)
      .filter(([, count]) =>
        Number.isFinite(Number(count))
      )
      .sort(
        (left, right) =>
          Number(right[1]) -
          Number(left[1])
      );

  if (
    rejected === 0 &&
    reasonEntries.length === 0
  ) {
    rejectionSummaryElement.textContent =
      "No rejected lines have been reported.";
  } else {
    const parts = reasonEntries.map(
      ([reason, count]) =>
        reason +
        ": " +
        formatInteger(count)
    );

    rejectionSummaryElement.textContent =
      formatInteger(rejected) +
      " rejected lines" +
      (
        parts.length > 0
          ? " - " + parts.join("; ")
          : ""
      );
  }

  const samples = Array.isArray(
    importState?.rejectionSamples
  )
    ? importState.rejectionSamples.slice(
        0,
        MAX_REJECTION_SAMPLES
      )
    : [];

  for (const sample of samples) {
    const item =
      document.createElement("li");
    item.textContent = String(sample);
    rejectionSamplesElement.append(item);
  }
}

function displayImportState(
  importState
) {
  const completed = Number(
    importState?.completedSources ?? 0
  );

  const expected = Number(
    importState?.expectedSourceCount ??
      SOURCE_FILES.length
  );

  const currentIndex = Number(
    importState?.currentSource ?? 0
  );

  const currentName =
    importState?.currentSourceName ||
    (
      currentIndex >= 1
        ? SOURCE_FILES[
            currentIndex - 1
          ]
        : ""
    );

  currentSourceOutput.textContent =
    currentName
      ? (
          currentName +
          " (" +
          formatInteger(currentIndex) +
          " of " +
          formatInteger(expected) +
          ")"
        )
      : "-";

  const completedNames =
    Array.isArray(
      importState?.completedSourceNames
    )
      ? importState.completedSourceNames
      : [];

  completedSourcesOutput.textContent =
    formatInteger(completed) +
    " of " +
    formatInteger(expected) +
    (
      completedNames.length > 0
        ? " - " +
          completedNames.join(", ")
        : ""
    );

  acceptedCountOutput.textContent =
    formatInteger(
      importState?.accepted ?? 0
    );

  progressElement.max =
    Math.max(expected, 1);

  progressElement.value =
    Math.min(
      Math.max(completed, 0),
      Math.max(expected, 1)
    );

  progressElement.hidden =
    !importRunning && !importState;

  displayRejectedInformation(
    importState
  );
}

function displayStatus(status) {
  latestStatus = status ?? {};
  savedImportState =
    status?.resumableImport === true
      ? status.importState
      : null;

  enabledInput.checked =
    status?.enabled !== false;

  protectedLabelsInput.value =
    Array.isArray(
      status?.protectedLabels
    )
      ? status.protectedLabels.join("\n")
      : "";

  labelCountOutput.textContent =
    formatInteger(status?.count ?? 0);

  activeGenerationOutput.textContent =
    status?.generation
      ? formatInteger(
          status.generation
        )
      : "-";

  previousGenerationOutput.textContent =
    status?.previousGeneration
      ? formatInteger(
          status.previousGeneration
        )
      : "-";

  importedAtOutput.textContent =
    formatDate(status?.importedAt);

  sourceCountOutput.textContent =
    formatInteger(SOURCE_FILES.length);

  displayPublicSuffixStatus(
    status?.publicSuffix
  );

  if (importRunning) {
    indexStatusOutput.textContent =
      status?.active
        ? (
            "Building replacement index; " +
            "the current index remains active"
          )
        : "Building label index";
  } else if (savedImportState) {
    indexStatusOutput.textContent =
      "Resumable build: " +
      formatInteger(
        savedImportState.completedSources ??
          0
      ) +
      " of " +
      formatInteger(
        savedImportState.expectedSourceCount ??
          SOURCE_FILES.length
      ) +
      " sources completed";
  } else if (status?.active) {
    indexStatusOutput.textContent =
      "Active label index";
  } else {
    indexStatusOutput.textContent =
      "No active label index";
  }

  displayImportState(
    savedImportState
  );

  if (
    savedImportState &&
    !importRunning
  ) {
    if (
      sourceConfigurationMatches(
        savedImportState
      )
    ) {
      const nextSource = Math.min(
        Number(
          savedImportState.completedSources ??
            0
        ) + 1,
        SOURCE_FILES.length
      );

      progressTextOutput.textContent =
        "The build can resume at " +
        SOURCE_FILES[nextSource - 1] +
        ", source " +
        nextSource +
        " of " +
        SOURCE_FILES.length +
        ". The interrupted source will restart.";
    } else {
      progressTextOutput.textContent =
        "The saved build uses a different source list. Discard it before starting a new import.";
    }
  }

  setControls();
}

async function refreshStatus() {
  const status =
    await api.runtime.sendMessage({
      type: "get-status"
    });

  displayStatus(status);
  return status;
}

async function saveSettings() {
  const protectedLabels =
    protectedLabelsFromInput();

  const status =
    await api.runtime.sendMessage({
      type: "set-settings",
      enabled: enabledInput.checked,
      protectedLabels
    });

  displayStatus(status);

  setOutputStatus(
    maintenanceStatusOutput,
    "Filtering settings saved.",
    "success"
  );
}

function rejectionResult(
  reason,
  original
) {
  return {
    label: "",
    reason,
    sample: String(original).slice(
      0,
      300
    )
  };
}

function normalizeCompactLabel(value) {
  let label = String(value)
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase();

  if (!label) {
    return "";
  }

  if (label.startsWith("*://*.")) {
    label = label.slice(6);
  } else if (
    label.startsWith("*://")
  ) {
    label = label.slice(4);
    label = label.replace(
      /^\*\./,
      ""
    );
  }

  if (label.endsWith("/*")) {
    label = label.slice(0, -2);
  }

  label = label
    .replace(/^\.+/, "")
    .replace(/\.+$/, "");

  if (
    label.length === 0 ||
    label.length > MAX_LABEL_LENGTH ||
    label.includes("/") ||
    label.includes("\\") ||
    label.includes(":") ||
    label.includes("?") ||
    label.includes("#") ||
    label.includes("*") ||
    label.includes("|") ||
    label.includes("^") ||
    label.includes(".") ||
    !/^[a-z0-9_-]+$/.test(label) ||
    label.startsWith("-") ||
    label.endsWith("-")
  ) {
    return "";
  }

  return label;
}

function parseSourceLine(value) {
  const original = String(value);

  let line = original
    .replace(/^\uFEFF/, "")
    .trim();

  if (!line) {
    return rejectionResult(
      "empty-line",
      original
    );
  }

  if (
    line.startsWith("#") ||
    line.startsWith("!")
  ) {
    return rejectionResult(
      "comment-or-directive",
      original
    );
  }

  if (line.includes("\u0000")) {
    return rejectionResult(
      "nul-character",
      original
    );
  }

  const fields = line.split(/\s+/);

  if (
    fields.length >= 2 &&
    /^(?:0\.0\.0\.0|127\.0\.0\.1|::1)$/.test(
      fields[0]
    )
  ) {
    line = fields[1];
  } else {
    line = fields[0];
  }

  if (
    !line ||
    line.startsWith("@@")
  ) {
    return rejectionResult(
      "exception-rule",
      original
    );
  }

  let label = line.toLowerCase();

  if (label.startsWith("*://*.")) {
    label = label.slice(6);
  } else if (
    label.startsWith("*://")
  ) {
    label = label.slice(4);
    label = label.replace(
      /^\*\./,
      ""
    );
  }

  if (label.endsWith("/*")) {
    label = label.slice(0, -2);
  }

  label = label
    .replace(/^\.+/, "")
    .replace(/\.+$/, "");

  if (!label) {
    return rejectionResult(
      "empty-after-normalization",
      original
    );
  }

  if (
    label.length >
    MAX_LABEL_LENGTH
  ) {
    return rejectionResult(
      "longer-than-63-characters",
      original
    );
  }

  if (label.includes(".")) {
    return rejectionResult(
      "contains-dot",
      original
    );
  }

  if (
    /[/\\:?#*|^]/.test(label)
  ) {
    return rejectionResult(
      "unsupported-rule-syntax",
      original
    );
  }

  if (
    !/^[a-z0-9_-]+$/.test(label)
  ) {
    return rejectionResult(
      "unsupported-characters",
      original
    );
  }

  if (
    label.startsWith("-") ||
    label.endsWith("-")
  ) {
    return rejectionResult(
      "leading-or-trailing-hyphen",
      original
    );
  }

  return {
    label,
    reason: "",
    sample: ""
  };
}

function throwIfPaused() {
  if (pauseRequested) {
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
    const text =
      await response.text();

    for (
      const line of
        text.split(/\r?\n/)
    ) {
      throwIfPaused();
      await onLine(line);
    }

    return;
  }

  const reader =
    response.body.getReader();

  const decoder =
    new TextDecoder("utf-8", {
      fatal: false
    });

  let remainder = "";

  try {
    while (true) {
      throwIfPaused();

      const part =
        await reader.read();

      if (part.done) {
        break;
      }

      remainder += decoder.decode(
        part.value,
        {
          stream: true
        }
      );

      let lineStart = 0;

      for (
        let index = 0;
        index < remainder.length;
        index++
      ) {
        if (
          remainder.charCodeAt(
            index
          ) !== 10
        ) {
          continue;
        }

        let line = remainder.slice(
          lineStart,
          index
        );

        if (line.endsWith("\r")) {
          line = line.slice(
            0,
            -1
          );
        }

        await onLine(line);
        lineStart = index + 1;
      }

      remainder =
        remainder.slice(lineStart);

      if (
        remainder.length >
        MAX_LINE_LENGTH
      ) {
        throw new Error(
          "A source contains a line larger than 1 MiB."
        );
      }
    }

    remainder += decoder.decode();

    if (remainder.length > 0) {
      if (
        remainder.endsWith("\r")
      ) {
        remainder = remainder.slice(
          0,
          -1
        );
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

function updateLiveProgress(
  sourceIndex,
  sourceName,
  sessionTotals,
  completedSources
) {
  currentSourceOutput.textContent =
    sourceName +
    " (" +
    sourceIndex +
    " of " +
    SOURCE_FILES.length +
    ")";

  completedSourcesOutput.textContent =
    formatInteger(completedSources) +
    " of " +
    formatInteger(
      SOURCE_FILES.length
    );

  acceptedCountOutput.textContent =
    formatInteger(
      sessionTotals.accepted
    );

  rejectedCountOutput.textContent =
    formatInteger(
      sessionTotals.rejected
    );

  progressElement.hidden = false;
  progressElement.max =
    SOURCE_FILES.length;
  progressElement.value =
    completedSources;
}

function addRejection(
  sourceStatistics,
  parsed
) {
  sourceStatistics.rejected++;

  sourceStatistics.reasons[
    parsed.reason
  ] =
    Number(
      sourceStatistics.reasons[
        parsed.reason
      ] ?? 0
    ) + 1;

  if (
    sourceStatistics.samples.length <
      MAX_REJECTION_SAMPLES &&
    parsed.sample
  ) {
    sourceStatistics.samples.push(
      parsed.reason +
      ": " +
      parsed.sample
    );
  }
}

async function sendImportBatch(
  importId,
  sourceIndex,
  sourceName,
  labels
) {
  throwIfPaused();

  const response =
    await api.runtime.sendMessage({
      type: "append-import-batch",
      importId,
      sourceIndex,
      sourceName,
      labels
    });

  if (!response) {
    throw new Error(
      "The background process returned no batch response."
    );
  }
}

async function sendRejections(
  importId,
  sourceIndex,
  sourceName,
  sourceStatistics
) {
  if (
    sourceStatistics.rejected === 0
  ) {
    return;
  }

  await api.runtime.sendMessage({
    type: "record-rejections",
    importId,
    sourceIndex,
    sourceName,
    count:
      sourceStatistics.rejected,
    reasons:
      sourceStatistics.reasons,
    samples:
      sourceStatistics.samples
  });
}

async function importSource(
  importId,
  sourceIndex,
  sourceName,
  sourceUrl,
  sessionTotals,
  completedSources
) {
  throwIfPaused();

  progressTextOutput.textContent =
    "Downloading " +
    sourceName +
    ", source " +
    sourceIndex +
    " of " +
    SOURCE_FILES.length +
    ".";

  updateLiveProgress(
    sourceIndex,
    sourceName,
    sessionTotals,
    completedSources
  );

  activeFetchController =
    new AbortController();

  let response;

  try {
    response = await fetch(
      sourceUrl,
      {
        cache: "no-store",
        credentials: "omit",
        redirect: "follow",
        signal:
          activeFetchController.signal
      }
    );

    if (!response.ok) {
      throw new Error(
        "Download failed with HTTP " +
        response.status +
        ": " +
        sourceUrl
      );
    }

    const contentLengthHeader =
      response.headers.get(
        "content-length"
      );

    const declaredByteLength =
      Number(
        contentLengthHeader ?? 0
      );

    const etag =
      response.headers.get(
        "etag"
      ) ?? "";

    const lastModified =
      response.headers.get(
        "last-modified"
      ) ?? "";

    let actualByteLength = 0;
    let batchSet = new Set();

    const sourceStatistics = {
      lines: 0,
      accepted: 0,
      rejected: 0,
      reasons: {},
      samples: []
    };

    async function flushBatch() {
      if (batchSet.size === 0) {
        return;
      }

      throwIfPaused();

      const labels =
        Array.from(batchSet);

      batchSet = new Set();

      await sendImportBatch(
        importId,
        sourceIndex,
        sourceName,
        labels
      );

      progressTextOutput.textContent =
        "Importing " +
        sourceName +
        ", source " +
        sourceIndex +
        " of " +
        SOURCE_FILES.length +
        ". Session labels: " +
        formatInteger(
          sessionTotals.accepted
        ) +
        "; rejected: " +
        formatInteger(
          sessionTotals.rejected
        ) +
        ".";

      await new Promise(
        (resolve) => {
          setTimeout(resolve, 0);
        }
      );
    }

    if (response.body) {
      const originalBody =
        response.body;

      const reader =
        originalBody.getReader();

      const measuredStream =
        new ReadableStream({
          async pull(controller) {
            const part =
              await reader.read();

            if (part.done) {
              controller.close();
              return;
            }

            actualByteLength +=
              part.value.byteLength;

            controller.enqueue(
              part.value
            );
          },
          cancel(reason) {
            return reader.cancel(
              reason
            );
          }
        });

      response = new Response(
        measuredStream,
        {
          status: response.status,
          statusText:
            response.statusText,
          headers:
            response.headers
        }
      );
    }

    await streamResponseLines(
      response,
      async (line) => {
        throwIfPaused();

        sourceStatistics.lines++;
        sessionTotals.lines++;

        const parsed =
          parseSourceLine(line);

        if (!parsed.label) {
          addRejection(
            sourceStatistics,
            parsed
          );

          sessionTotals.rejected++;

          updateLiveProgress(
            sourceIndex,
            sourceName,
            sessionTotals,
            completedSources
          );

          return;
        }

        sourceStatistics.accepted++;
        sessionTotals.accepted++;
        batchSet.add(parsed.label);

        if (
          batchSet.size >=
          IMPORT_BATCH_SIZE
        ) {
          await flushBatch();
        }
      }
    );

    await flushBatch();

    await sendRejections(
      importId,
      sourceIndex,
      sourceName,
      sourceStatistics
    );

    if (
      actualByteLength === 0 &&
      Number.isSafeInteger(
        declaredByteLength
      ) &&
      declaredByteLength > 0
    ) {
      actualByteLength =
        declaredByteLength;
    }

    if (
      actualByteLength < 1
    ) {
      throw new Error(
        "The source byte length could not be verified."
      );
    }

    await api.runtime.sendMessage({
      type: "complete-import-source",
      importId,
      sourceIndex,
      sourceName,
      byteLength:
        actualByteLength,
      lineCount:
        sourceStatistics.lines,
      acceptedCount:
        sourceStatistics.accepted,
      rejectedCount:
        sourceStatistics.rejected,
      etag,
      lastModified
    });
  } finally {
    activeFetchController = null;
  }
}

async function runRemainingSources(
  importId,
  firstSourceIndex,
  alreadyCompleted
) {
  const sessionTotals = {
    lines: 0,
    accepted: 0,
    rejected: 0
  };

  let completedSources =
    alreadyCompleted;

  for (
    let index =
      firstSourceIndex - 1;
    index < SOURCE_FILES.length;
    index++
  ) {
    await importSource(
      importId,
      index + 1,
      SOURCE_FILES[index],
      SOURCE_URLS[index],
      sessionTotals,
      completedSources
    );

    completedSources = index + 1;

    progressElement.value =
      completedSources;

    completedSourcesOutput.textContent =
      completedSources +
      " of " +
      SOURCE_FILES.length;
  }

  throwIfPaused();

  progressTextOutput.textContent =
    "All sources completed. Verifying and activating the new label index...";

  const result =
    await api.runtime.sendMessage({
      type: "finish-import",
      importId
    });

  progressElement.value =
    SOURCE_FILES.length;

  setOutputStatus(
    progressTextOutput,
    "Import complete. The active index contains " +
      formatInteger(
        result?.exactCount ??
        result?.count ??
        0
      ) +
      " exact hostname labels.",
    "success"
  );

  await refreshStatus();
}

async function startNewImport() {
  if (
    importRunning ||
    savedImportState
  ) {
    return;
  }

  const confirmed =
    globalThis.confirm(
      "Start a new import of all 17 source files? " +
      "They will be processed sequentially. " +
      "The current active index remains available until the replacement is complete."
    );

  if (!confirmed) {
    return;
  }

  importRunning = true;
  pauseRequested = false;
  activeImportId =
    createImportId();

  setControls();

  progressElement.hidden = false;
  progressElement.max =
    SOURCE_FILES.length;
  progressElement.value = 0;

  progressTextOutput.textContent =
    "Preparing a new resumable label index...";

  try {
    const response =
      await api.runtime.sendMessage({
        type: "begin-import",
        importId: activeImportId,
        expectedSourceCount:
          SOURCE_FILES.length,
        sourceNames:
          Array.from(SOURCE_FILES)
      });

    activeImportId =
      response?.importId ??
      activeImportId;

    await runRemainingSources(
      activeImportId,
      1,
      0
    );
  } catch (error) {
    const paused =
      pauseRequested ||
      error?.name === "AbortError";

    setOutputStatus(
      progressTextOutput,
      paused
        ? (
            "Import paused. Completed sources remain stored. Use Resume import later."
          )
        : (
            "Import stopped after an error: " +
            errorMessage(error) +
            " Use Resume import to retry the current source."
          ),
      paused ? "" : "error"
    );
  } finally {
    activeFetchController = null;
    activeImportId = null;
    pauseRequested = false;
    importRunning = false;

    await refreshStatus().catch(
      console.error
    );
  }
}

async function resumeSavedImport() {
  if (
    importRunning ||
    !savedImportState
  ) {
    return;
  }

  if (
    !sourceConfigurationMatches(
      savedImportState
    )
  ) {
    throw new Error(
      "The saved import uses a different source list."
    );
  }

  const confirmed =
    globalThis.confirm(
      "Resume the saved import? " +
      "Completed sources remain stored, and the interrupted source will restart."
    );

  if (!confirmed) {
    return;
  }

  importRunning = true;
  pauseRequested = false;
  setControls();

  try {
    const response =
      await api.runtime.sendMessage({
        type: "resume-import",
        expectedSourceCount:
          SOURCE_FILES.length,
        sourceNames:
          Array.from(SOURCE_FILES)
      });

    activeImportId =
      response.importId;

    const completedSources =
      Number(
        response.completedSources ??
        savedImportState.completedSources ??
        0
      );

    const nextSource =
      Number(
        response.nextSource ??
        completedSources + 1
      );

    progressTextOutput.textContent =
      "Resuming at " +
      SOURCE_FILES[nextSource - 1] +
      ", source " +
      nextSource +
      " of " +
      SOURCE_FILES.length +
      ".";

    await runRemainingSources(
      activeImportId,
      nextSource,
      completedSources
    );
  } catch (error) {
    const paused =
      pauseRequested ||
      error?.name === "AbortError";

    setOutputStatus(
      progressTextOutput,
      paused
        ? (
            "Import paused. Use Resume import later."
          )
        : (
            "Import stopped after an error: " +
            errorMessage(error) +
            " Use Resume import to retry."
          ),
      paused ? "" : "error"
    );
  } finally {
    activeFetchController = null;
    activeImportId = null;
    pauseRequested = false;
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

  pauseRequested = true;
  pauseImportButton.disabled = true;

  progressTextOutput.textContent =
    "Pausing the current source...";

  if (activeFetchController) {
    activeFetchController.abort();
  }
}

async function abandonSavedImport() {
  if (
    importRunning ||
    !savedImportState
  ) {
    return;
  }

  const confirmed =
    globalThis.confirm(
      "Discard the unfinished build? " +
      "Its database will remain unused until Clean unused databases removes it."
    );

  if (!confirmed) {
    return;
  }

  abandonImportButton.disabled =
    true;

  const response =
    await api.runtime.sendMessage({
      type: "abandon-import",
      importId:
        savedImportState.importId
    });

  setOutputStatus(
    maintenanceStatusOutput,
    response?.message ??
      "The unfinished build was discarded.",
    "success"
  );

  await refreshStatus();
}

async function cleanUnusedDatabases() {
  cleanUnusedButton.disabled = true;

  setOutputStatus(
    maintenanceStatusOutput,
    "Cleaning unused databases..."
  );

  try {
    const result =
      await api.runtime.sendMessage({
        type: "clean-unused-databases"
      });
    const blocked = Array.isArray(
      result?.blocked
    )
      ? result.blocked
      : [];
    const failed = Array.isArray(
      result?.failed
    )
      ? result.failed
      : [];
    let message =
      "Deleted " +
      formatInteger(
        result?.deleted ?? 0
      ) +
      " unused database" +
      (
        Number(result?.deleted ?? 0) === 1
          ? "."
          : "s."
      );
    if (blocked.length > 0) {
      message +=
        " Blocked generations: " +
        blocked.join(", ") +
        ".";
    }
    if (failed.length > 0) {
      message +=
        " Failed deletions: " +
        formatInteger(failed.length) +
        ".";
    }
    setOutputStatus(
      maintenanceStatusOutput,
      message,
      (
        blocked.length === 0 &&
        failed.length === 0
      )
        ? "success"
        : "error"
    );
    await refreshStatus();
  } catch (error) {
    setOutputStatus(
      maintenanceStatusOutput,
      "Cleanup failed: " +
        errorMessage(error),
      "error"
    );
  } finally {
    setControls();
  }
}
async function deletePreviousGeneration() {
  if (
    importRunning ||
    savedImportState ||
    !latestStatus?.previousGeneration
  ) {
    return;
  }
  const confirmed =
    globalThis.confirm(
      "Delete the retained previous generation? " +
      "The active generation will remain available."
    );
  if (!confirmed) {
    return;
  }
  deletePreviousButton.disabled =
    true;
  setOutputStatus(
    maintenanceStatusOutput,
    "Deleting the previous generation..."
  );
  try {
    const result =
      await api.runtime.sendMessage({
        type:
          "delete-previous-generation"
      });
    if (result?.deleted === true) {
      setOutputStatus(
        maintenanceStatusOutput,
        "The previous generation was deleted.",
        "success"
      );
    } else if (
      result?.blocked === true
    ) {
      setOutputStatus(
        maintenanceStatusOutput,
        "Deletion is currently blocked. Close other extension pages and try again.",
        "error"
      );
    } else {
      setOutputStatus(
        maintenanceStatusOutput,
        result?.message ??
          result?.error ??
          "No previous generation was deleted.",
        result?.error ? "error" : ""
      );
    }
    await refreshStatus();
  } catch (error) {
    setOutputStatus(
      maintenanceStatusOutput,
      "Could not delete the previous generation: " +
        errorMessage(error),
      "error"
    );
  } finally {
    setControls();
  }
}
async function clearAllData() {
  if (
    importRunning ||
    savedImportState
  ) {
    throw new Error(
      "Pause and discard the unfinished build before deleting all index data."
    );
  }
  const confirmed =
    globalThis.confirm(
      "Delete all active, previous, and unfinished v2 index data? " +
      "Filtering will have no effect until another import completes."
    );
  if (!confirmed) {
    return;
  }
  clearDataButton.disabled = true;
  setOutputStatus(
    maintenanceStatusOutput,
    "Deleting all v2 index data..."
  );
  try {
    const result =
      await api.runtime.sendMessage({
        type: "clear-data"
      });
    const deletionResults =
      Array.isArray(
        result?.deletionResults
      )
        ? result.deletionResults
        : [];
    const deletedCount =
      deletionResults.filter(
        (item) =>
          item?.deleted === true
      ).length;
    const problemCount =
      deletionResults.filter(
        (item) =>
          item?.deleted !== true
      ).length;
    progressElement.hidden = true;
    displayStatus(result);
    setOutputStatus(
      maintenanceStatusOutput,
      "Index metadata was cleared. Deleted " +
        formatInteger(deletedCount) +
        " generation database" +
        (
          deletedCount === 1
            ? ""
            : "s"
        ) +
        (
          problemCount > 0
            ? "; " +
              formatInteger(problemCount) +
              " deletion operation" +
              (
                problemCount === 1
                  ? ""
                  : "s"
              ) +
              " did not finish."
            : "."
        ),
      problemCount > 0
        ? "error"
        : "success"
    );
  } catch (error) {
    setOutputStatus(
      maintenanceStatusOutput,
      "Could not delete all index data: " +
        errorMessage(error),
      "error"
    );
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
      setOutputStatus(
        maintenanceStatusOutput,
        "Could not save filtering settings: " +
          errorMessage(error),
        "error"
      );
    });
  }
);
saveSettingsButton.addEventListener(
  "click",
  () => {
    saveSettings().catch((error) => {
      console.error(error);
      setOutputStatus(
        maintenanceStatusOutput,
        "Could not save filtering settings: " +
          errorMessage(error),
        "error"
      );
    });
  }
);
startImportButton.addEventListener(
  "click",
  () => {
    startNewImport().catch((error) => {
      console.error(error);
      importRunning = false;
      pauseRequested = false;
      activeImportId = null;
      setOutputStatus(
        progressTextOutput,
        "Could not start import: " +
          errorMessage(error),
        "error"
      );
      setControls();
    });
  }
);
resumeImportButton.addEventListener(
  "click",
  () => {
    resumeSavedImport().catch(
      (error) => {
        console.error(error);
        importRunning = false;
        pauseRequested = false;
        activeImportId = null;
        setOutputStatus(
          progressTextOutput,
          "Could not resume import: " +
            errorMessage(error),
          "error"
        );
        setControls();
      }
    );
  }
);
pauseImportButton.addEventListener(
  "click",
  () => {
    pauseImport().catch((error) => {
      console.error(error);
      setOutputStatus(
        progressTextOutput,
        "Could not pause import: " +
          errorMessage(error),
        "error"
      );
      setControls();
    });
  }
);
abandonImportButton.addEventListener(
  "click",
  () => {
    abandonSavedImport().catch(
      (error) => {
        console.error(error);
        setOutputStatus(
          maintenanceStatusOutput,
          "Could not discard the unfinished build: " +
            errorMessage(error),
          "error"
        );
        setControls();
      }
    );
  }
);
cleanUnusedButton.addEventListener(
  "click",
  () => {
    cleanUnusedDatabases().catch(
      (error) => {
        console.error(error);
        setOutputStatus(
          maintenanceStatusOutput,
          "Could not clean unused databases: " +
            errorMessage(error),
          "error"
        );
        setControls();
      }
    );
  }
);
deletePreviousButton.addEventListener(
  "click",
  () => {
    deletePreviousGeneration().catch(
      (error) => {
        console.error(error);
        setOutputStatus(
          maintenanceStatusOutput,
          "Could not delete the previous generation: " +
            errorMessage(error),
          "error"
        );
        setControls();
      }
    );
  }
);
clearDataButton.addEventListener(
  "click",
  () => {
    clearAllData().catch((error) => {
      console.error(error);
      setOutputStatus(
        maintenanceStatusOutput,
        "Could not delete index data: " +
          errorMessage(error),
        "error"
      );
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
  setOutputStatus(
    progressTextOutput,
    errorMessage(error),
    "error"
  );
  setControls();
});